import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { read, safeErrorText, type Database } from '@repopulse/shared';
import {
  contextWindowForRole,
  runSpecialists,
  specialistById,
  type AnalysisGateway,
  type LlmRole,
  type RoutingPolicy,
  type SpecialistId,
  type T2Host,
} from '@repopulse/analysis';
import { dedupKey, persistFindings } from '@repopulse/insights';
import { TRIAGE_TOP_N, runTriage, type TriageCandidate } from '@repopulse/security';
import { overlaps, rangesByFile, type DiffRequest, type LoadedDiff } from './ai-pass-diff.js';

// ai.pass processor (W19-09): planned specialists, then evidence-fed triage, over
// one repository, through THIS workspace's routing chain.
//
// WHAT THIS CAN AND CANNOT DO.
//   - It reads a snapshot of the repository (never writes to it, D9a) and sends
//     the files it selected to the workspace's own model. Local-only, the routing
//     chain, the egress audit and the call cap are enforced by the gateway; this
//     code adds the cap on files, bytes and calls.
//   - It writes ordinary findings (the specialists') and triage SUGGESTIONS. It
//     never changes the status of an existing finding, never dismisses, never
//     resolves: persistFindings is called WITHOUT reviewedFiles, which is the only
//     thing that makes it auto-resolve, and the suggestion table has no way to
//     touch a finding.
//   - Every failure lands on the run row, in words. Nothing is retried (one
//     attempt): a retry would repeat dozens of model calls.

/** Hard limits on what a pass reads. A repo-wide pass is bounded, never "everything". */
export const AI_PASS_MAX_FILES = 40;
export const AI_PASS_MAX_BYTES = 400_000;
export const AI_PASS_MAX_PATHS = 50;
/** Gateway calls for one pass - specialists and triage together, retries counted. */
export const AI_PASS_MAX_CALLS = 30;

export interface AiPassJobData {
  workspaceId: number;
  runId: number;
  requestId?: string;
  /** A lower call cap for this pass (a scheduled pass is limited by what is left of the month). */
  maxCalls?: number;
}

export interface PassFile {
  path: string;
  content: string;
}

export type LoadedSources =
  { ok: true; commitSha: string; files: PassFile[] } | { ok: false; code: string; reason: string };

export interface AiPassDeps {
  db: Database;
  /** This workspace's gateway, its hosts and routing (W16-19); null when it has no model. */
  gatewayFor: (
    workspaceId: number,
  ) => Promise<{ gateway: AnalysisGateway; hosts: T2Host[]; routing?: RoutingPolicy } | null>;
  /** The repository's files at its head, restricted to `paths`. */
  loadSources: (args: {
    workspaceId: number;
    repoId: number;
    paths: string[];
  }) => Promise<LoadedSources>;
  /** The changes of a pull request or a commit range (W19-11); absent = diff mode unavailable. */
  loadDiff?: (req: DiffRequest) => Promise<LoadedDiff>;
  maxCalls?: number;
  now?: () => Date;
}

export type AiPassResult = {
  status: 'succeeded' | 'failed' | 'skipped';
  code?: string;
  reason?: string;
};

/** A file is in scope when it equals a path or sits under a directory prefix. */
export function inScope(file: string, paths: readonly string[]): boolean {
  return paths.some((p) => {
    const norm = p.replace(/\/+$/, '');
    return file === norm || file.startsWith(`${norm}/`);
  });
}

const stripPatchPrefix = (s: string): string => s.replace(/^\+/gm, '');

export function aiPassProcessor(deps: AiPassDeps) {
  const now = deps.now ?? (() => new Date());
  const baseMaxCalls = deps.maxCalls ?? AI_PASS_MAX_CALLS;

  return async function process(job: Job<AiPassJobData>): Promise<AiPassResult> {
    const { workspaceId, runId } = job.data;
    const maxCalls = Math.max(1, Math.min(baseMaxCalls, job.data.maxCalls ?? baseMaxCalls));
    const { db } = deps;

    // Always workspace-filtered (Law 5).
    const [run] = await db
      .select()
      .from(read.aiPassRuns)
      .where(and(eq(read.aiPassRuns.id, runId), eq(read.aiPassRuns.workspaceId, workspaceId)))
      .limit(1);
    if (!run) return { status: 'skipped', code: 'not_found', reason: 'No such pass.' };
    if (run.status !== 'pending') {
      return { status: 'skipped', code: 'already_started', reason: `Already ${run.status}.` };
    }

    const finish = async (
      status: 'succeeded' | 'failed' | 'skipped',
      patch: Partial<typeof read.aiPassRuns.$inferInsert> = {},
    ): Promise<AiPassResult> => {
      await db
        .update(read.aiPassRuns)
        .set({ status, finishedAt: now(), ...patch })
        .where(eq(read.aiPassRuns.id, runId));
      return {
        status,
        ...(patch.reasonCode ? { code: patch.reasonCode } : {}),
        ...(patch.reason ? { reason: patch.reason } : {}),
      };
    };
    const fail = (
      code: string,
      reason: string,
      extra: Partial<typeof read.aiPassRuns.$inferInsert> = {},
    ) => finish('failed', { reasonCode: code, reason: reason.slice(0, 2000), ...extra });
    // W20-11 (UX_TODO AI-60): what a pass had already done when it failed
    // partway (LM Studio crashing during triage, say). The calls were made, so
    // they count toward the monthly cap, and the findings the specialists had
    // already written are on the repository; both were dropped from the row.
    // Calls inside a triage step that then threw are not known here, so the
    // count is the specialists' (a floor, never an overcount).
    let progress: Partial<typeof read.aiPassRuns.$inferInsert> = {};

    await db
      .update(read.aiPassRuns)
      .set({ status: 'running', startedAt: now() })
      .where(eq(read.aiPassRuns.id, runId));

    try {
      const wg = await deps.gatewayFor(workspaceId);
      if (!wg) {
        return fail(
          'no_gateway',
          'No model is configured for this workspace, so there was nothing to run the pass on. Add one in Admin → Models.',
        );
      }

      // What is reviewed: the repository's files at its head (paths mode), or the
      // changes of a pull request / commit range (diff modes).
      let input: Parameters<typeof runSpecialists>[0];
      let promptTitle: string;
      let filesRead: number;
      let unreadable: string[] = [];
      let diffRanges: Map<string, [number, number][]> | null = null;
      let commitSha: string;
      if (run.mode === 'paths') {
        const loaded = await deps.loadSources({
          workspaceId,
          repoId: run.repoId,
          paths: run.paths,
        });
        if (!loaded.ok) return fail(loaded.code, loaded.reason);
        commitSha = loaded.commitSha;
        input = { kind: 'module', name: `repo-${run.repoId}`, files: loaded.files };
        promptTitle = `Repository pass over ${run.paths.join(', ')}`;
        filesRead = loaded.files.length;
      } else {
        if (!deps.loadDiff) {
          return fail('no_diff_source', 'Reviewing a diff is not available on this server.');
        }
        const loaded = await deps.loadDiff({
          workspaceId,
          repoId: run.repoId,
          mode: run.mode,
          prNumber: run.prNumber,
          base: run.baseRef,
          head: run.headRef,
        });
        if (!loaded.ok) return fail(loaded.code, loaded.reason);
        commitSha = loaded.commitSha;
        input = {
          kind: 'diff',
          files: loaded.files.map((f) => ({ path: f.path, patch: f.patch })),
        };
        promptTitle = loaded.title;
        filesRead = loaded.files.length;
        unreadable = loaded.unreadable;
        diffRanges = rangesByFile(loaded.files);
        await db
          .update(read.aiPassRuns)
          .set({ baseRef: loaded.baseRef, headRef: loaded.headRef })
          .where(eq(read.aiPassRuns.id, runId));
      }
      await db.update(read.aiPassRuns).set({ commitSha }).where(eq(read.aiPassRuns.id, runId));

      const window = (id: SpecialistId): number | null =>
        contextWindowForRole(wg.routing, specialistById(id).role as LlmRole, wg.hosts);

      // 1. The planned specialists. A third of the call cap (at most what triage can
      // use) is held back for triage, so a tight cap cannot starve it entirely; any
      // of it the specialists do not need is still the cap, not extra.
      const triageReserve = Math.min(TRIAGE_TOP_N * 2, Math.floor(maxCalls / 3));
      const spec = await runSpecialists(input, {
        gateway: wg.gateway,
        contextWindowFor: window,
        maxCalls: maxCalls - triageReserve,
        prTitle: promptTitle,
        meta: { repoId: String(run.repoId), prNumber: 0, initiator: 'ai-pass' },
      });
      progress = {
        calls: spec.calls,
        specialists: {
          usage: spec.usage,
          droppedForBudget: spec.droppedForBudget,
          failures: spec.failures,
          rejected: spec.rejected.length,
          filesRead,
        },
      };

      // 2. Persist what they found, as ordinary findings, and how each was raised.
      const analysisRunIds: number[] = [];
      for (const [id, usage] of Object.entries(spec.usage) as [
        SpecialistId,
        NonNullable<(typeof spec.usage)[SpecialistId]>,
      ][]) {
        const mine = spec.findings.filter((f) => f.specialist === id);
        if (mine.length === 0) continue;
        const sp = specialistById(id);
        const [ar] = await db
          .insert(read.analysisRuns)
          .values({
            workspaceId,
            repoId: run.repoId,
            tier: 2,
            dimension: sp.dimension,
            checklistVersion: sp.checklistVersion,
            modelId: usage.models[0] ?? 'unknown',
            status: 'succeeded',
            passKind: 'find',
            chunkCount: usage.chunks,
            promptTokens: usage.tokensIn,
            outputTokens: usage.tokensOut,
            startedAt: run.startedAt ?? now(),
            finishedAt: now(),
          })
          .returning({ id: read.analysisRuns.id });
        analysisRunIds.push(ar!.id);

        const incoming = mine.map((f) => ({
          dimension: f.dimension,
          severity: f.severity,
          confidence: f.confidence,
          file: f.file,
          lineStart: Math.max(1, f.line_range[0]),
          lineEnd: Math.max(1, f.line_range[1]),
          title: f.title,
          evidenceQuote: stripPatchPrefix(f.evidence_quote),
          rationale: f.rationale,
          suggestedFix: f.suggested_fix,
          // No scanner and no rule: these are a model's judgement, not a rule's.
          scannerKey: null,
          ruleId: null,
        }));
        // NO reviewedFiles: that is what would let this auto-resolve other findings.
        await persistFindings(db, {
          workspaceId,
          repoId: run.repoId,
          analysisRunId: ar!.id,
          pullRequestId: null,
          tier: 2,
          findings: incoming,
        });

        const keys = incoming.map((f) =>
          dedupKey({
            dimension: f.dimension,
            file: f.file,
            evidenceQuote: f.evidenceQuote,
            lineStart: f.lineStart,
            scannerKey: null,
            ruleId: null,
          }),
        );
        const rows = await db
          .select({ id: read.findings.id, key: read.findings.dedupKey })
          .from(read.findings)
          .where(
            and(
              eq(read.findings.workspaceId, workspaceId),
              eq(read.findings.repoId, run.repoId),
              inArray(read.findings.dedupKey, keys),
            ),
          );
        const idByKey = new Map(rows.map((r) => [r.key, r.id]));
        for (const [i, f] of mine.entries()) {
          const findingId = idByKey.get(keys[i]!);
          if (findingId === undefined) continue;
          await db
            .insert(read.aiFindingProvenance)
            .values({
              workspaceId,
              findingId,
              aiPassRunId: runId,
              specialist: id,
              checklistVersion: f.checklistVersion,
              model: f.model,
              route: (f.route ?? null) as Record<string, unknown> | null,
            })
            .onConflictDoNothing();
        }
      }

      // 3. Evidence-fed triage of RULE-raised findings in scope.
      const triage = await triageStep({
        deps,
        wg,
        run,
        workspaceId,
        runId,
        callsSoFar: spec.calls,
        maxCalls,
        now,
        diffRanges,
      });

      const planned = spec.plan.waves.flatMap((w) => w.specialists.map((s) => s.specialist.id));
      const summary = {
        waves: spec.plan.waves.map((w) => ({
          wave: w.wave,
          specialists: w.specialists.map((s) => ({ id: s.specialist.id, reason: s.reason })),
        })),
        skipped: spec.plan.skipped,
        counts: spec.plan.counts,
      };
      const nothingRelevant = planned.length === 0 && triage.skipped !== null;
      // W20-06 (UX_TODO AI-59): a pass where every specialist that ran gave only
      // unusable answers (malformed JSON twice, common with local models) and
      // triage reviewed nothing has reviewed NOTHING. Recorded as failed, with
      // the reason, so it can never read as "✓ finished, no findings".
      const ran = planned.filter((id) => !spec.droppedForBudget.includes(id));
      const failedIds = new Set(spec.failures.map((f) => f.specialist));
      const allSpecialistsFailed =
        ran.length > 0 &&
        ran.every((id) => failedIds.has(id) && (spec.usage[id]?.findings ?? 0) === 0);
      const triageReviewed = ((triage.funnel as { triaged?: number } | null)?.triaged ?? 0) > 0;
      const unusable = allSpecialistsFailed && !triageReviewed;
      return finish(nothingRelevant ? 'skipped' : unusable ? 'failed' : 'succeeded', {
        plan: summary,
        specialists: {
          usage: spec.usage,
          droppedForBudget: spec.droppedForBudget,
          failures: spec.failures,
          rejected: spec.rejected.length,
          filesRead,
          ...(unreadable.length > 0 ? { unreadable } : {}),
        },
        triageFunnel: triage.funnel as unknown as Record<string, unknown> | null,
        triageSkipped: triage.skipped,
        calls: spec.calls + triage.calls,
        analysisRunIds,
        ...(nothingRelevant
          ? {
              reasonCode: 'nothing_relevant',
              reason: 'Nothing in scope needed a specialist, and there was nothing to triage.',
            }
          : unusable
            ? {
                reasonCode: 'specialists_unusable',
                reason:
                  'No specialist gave a usable answer (each answer was malformed, even after a retry), so this pass reviewed nothing. Try a model that follows JSON instructions more reliably.',
              }
            : {}),
      });
    } catch (err) {
      // A local-only refusal arrives here with its sentence (role and connection).
      return fail('error', safeErrorText(err), progress);
    }
  };
}

async function triageStep(a: {
  deps: AiPassDeps;
  wg: { gateway: AnalysisGateway; hosts: T2Host[]; routing?: RoutingPolicy };
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  runId: number;
  callsSoFar: number;
  maxCalls: number;
  now: () => Date;
  /** Diff modes: the lines the change adds, per file; triage is limited to findings on them. */
  diffRanges: Map<string, [number, number][]> | null;
}): Promise<{ funnel: object | null; skipped: string | null; calls: number }> {
  const { db } = a.deps;
  const remaining = a.maxCalls - a.callsSoFar;
  if (remaining < 1) {
    return {
      funnel: null,
      skipped: 'The call cap was used up by the specialists, so triage did not run.',
      calls: 0,
    };
  }

  // Rule-raised, open, with the stored code context (no forge call), in scope,
  // and not already carrying a suggestion - one suggestion per finding, and a
  // person's decision is never re-asked.
  const rows = await db
    .select()
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, a.workspaceId),
        eq(read.findings.repoId, a.run.repoId),
        eq(read.findings.status, 'open'),
        eq(read.findings.experimental, false),
        isNotNull(read.findings.scannerKey),
        isNotNull(read.findings.ruleId),
        isNotNull(read.findings.file),
        isNotNull(read.findings.lineStart),
        isNotNull(read.findings.contextLines),
        sql`not exists (select 1 from ai_triage_verdicts v where v.finding_id = ${read.findings.id} and v.workspace_id = ${a.workspaceId})`,
      ),
    )
    .orderBy(desc(read.findings.effectiveRisk))
    .limit(200);
  const ranges = a.diffRanges;
  const scoped = rows.filter((r) => {
    if (r.file === null) return false;
    // Diff modes: only a finding on lines the change adds or alters.
    if (ranges) {
      const mine = ranges.get(r.file);
      return mine !== undefined && overlaps(mine, r.lineStart!, r.lineEnd ?? r.lineStart!);
    }
    return inScope(r.file, a.run.paths);
  });
  if (scoped.length === 0) {
    return {
      funnel: null,
      skipped: ranges
        ? 'No open rule-raised finding sits on lines this change adds or alters (with stored code context and no earlier suggestion), so there was nothing to triage.'
        : 'No open rule-raised finding in scope has stored code context and no earlier suggestion, so there was nothing to triage.',
      calls: 0,
    };
  }

  const byKey = new Map(scoped.map((r) => [r.dedupKey, r]));
  const candidates: TriageCandidate[] = scoped.map((r) => ({
    finding: {
      dedupKey: r.dedupKey,
      scannerKey: r.scannerKey!,
      ruleId: r.ruleId!,
      title: r.title,
      dimension: r.dimension,
      file: r.file!,
      lineStart: r.lineStart!,
      lineEnd: r.lineEnd ?? r.lineStart!,
      evidenceQuote: r.evidence,
    },
    // Only dependency findings carry a reachability tier; for a rule-raised code
    // finding it is "not computed" and the prompt says so.
    reachability: { tier: null },
    source: r.contextLines!,
    sourceStartLine: r.contextStartLine ?? 1,
    effectiveRisk: Number(r.effectiveRisk ?? 0),
  }));

  const result = await runTriage(candidates, {
    gateway: a.wg.gateway,
    contextWindow: contextWindowForRole(a.wg.routing, 'triage', a.wg.hosts),
    limit: TRIAGE_TOP_N,
    maxCalls: remaining,
    meta: { repoId: String(a.run.repoId), prNumber: 0, initiator: 'ai-pass' },
  });

  for (const p of result.proposals) {
    const row = byKey.get(p.dedupKey);
    if (!row) continue;
    await db
      .insert(read.aiTriageVerdicts)
      .values({
        workspaceId: a.workspaceId,
        findingId: row.id,
        aiPassRunId: a.runId,
        verdict: p.verdict,
        confidence: p.confidence,
        model: p.model,
        checklistVersion: p.checklistVersion,
        rationale: p.rationale,
        citations: p.citations,
        vexJustification: p.vex?.justification ?? null,
        vexStatement: p.vex?.statement ?? null,
        // Only a patch that a re-scan proved is ever stored.
        patchDiff: p.patch?.status === 'verified' ? p.patch.diff : null,
        patchStatus: p.patch?.status ?? 'not_attempted',
        patchReason: p.patch?.reason ?? null,
        route: p.route as Record<string, unknown> | null,
      })
      .onConflictDoNothing();
  }
  return { funnel: result.funnel, skipped: null, calls: result.calls };
}
