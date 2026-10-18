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
  const maxCalls = deps.maxCalls ?? AI_PASS_MAX_CALLS;

  return async function process(job: Job<AiPassJobData>): Promise<AiPassResult> {
    const { workspaceId, runId } = job.data;
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
    const fail = (code: string, reason: string, extra = {}) =>
      finish('failed', { reasonCode: code, reason: reason.slice(0, 2000), ...extra });

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

      const loaded = await deps.loadSources({ workspaceId, repoId: run.repoId, paths: run.paths });
      if (!loaded.ok) return fail(loaded.code, loaded.reason);
      await db
        .update(read.aiPassRuns)
        .set({ commitSha: loaded.commitSha })
        .where(eq(read.aiPassRuns.id, runId));

      const window = (id: SpecialistId): number | null =>
        contextWindowForRole(wg.routing, specialistById(id).role as LlmRole, wg.hosts);

      // 1. The planned specialists.
      const spec = await runSpecialists(
        { kind: 'module', name: `repo-${run.repoId}`, files: loaded.files },
        {
          gateway: wg.gateway,
          contextWindowFor: window,
          maxCalls,
          prTitle: `Repository pass over ${run.paths.join(', ')}`,
          meta: { repoId: String(run.repoId), prNumber: 0, initiator: 'ai-pass' },
        },
      );

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
      return finish(nothingRelevant ? 'skipped' : 'succeeded', {
        plan: summary,
        specialists: {
          usage: spec.usage,
          droppedForBudget: spec.droppedForBudget,
          failures: spec.failures,
          rejected: spec.rejected.length,
          filesRead: loaded.files.length,
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
          : {}),
      });
    } catch (err) {
      // A local-only refusal arrives here with its sentence (role and connection).
      return fail('error', safeErrorText(err));
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
  const scoped = rows.filter((r) => r.file !== null && inScope(r.file, a.run.paths));
  if (scoped.length === 0) {
    return {
      funnel: null,
      skipped:
        'No open rule-raised finding in scope has stored code context and no earlier suggestion, so there was nothing to triage.',
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
