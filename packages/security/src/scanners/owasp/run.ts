import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, readImportGraph, type IncomingFinding } from '@repopulse/insights';
import {
  chunkDiff,
  validateFindings,
  FindingParseError,
  meetsTrigger,
  type AnalysisGateway,
  type DiffFile,
} from '@repopulse/analysis';
import { repoContextFor } from '../context/repo-context.js';
import { buildChecklistPrompt, loadChecklist, type ChecklistKey } from './checklist.js';
import { owaspLlmApplies } from './llm-packages.js';

// OWASP checklist scanners (W8-08, SECURITY_SUITE.md §3.4, FR-SEC-7).
//
// These are the only scanners that call a model, and they do it through the
// ANALYSIS GATEWAY — not because the gateway is convenient, but because every
// control lives behind it: the 45k token cap, the warm-up and crash retry, the
// Tier-3 opt-in check and the egress audit row. A scanner that called an LLM
// directly would bypass all four at once (Law 8).

export interface OwaspRunDeps {
  db: Database;
  gateway: AnalysisGateway;
  workspaceId: number;
  repoId: number;
  /** Diff to review — the changed files of a PR, or a scheduled surface. */
  files: readonly DiffFile[];
  commitSha: string;
  prNumber?: number;
  pullRequestId?: number | null;
  trigger?: 'schedule' | 'manual' | 'pr_synced';
  /** Tier-3 opt-in for this repo; escalation is decided, never assumed. */
  t3OptIn?: boolean;
  checklistDir?: string;
}

export interface OwaspRunResult {
  status: 'succeeded' | 'failed' | 'skipped';
  scanRunId: number | null;
  findingsCreated: number;
  findingsTotal: number;
  chunks: number;
  /** Findings the validator threw out — reported, never silent. */
  rejected: number;
  /** Findings that MET a T3 trigger, and whether they could escalate. */
  escalations: { met: number; permitted: number };
  skippedReason?: 'no_llm_packages' | 'no_sbom' | 'no_diff';
  error?: string;
}

const KEY_DIMENSION = 'security' as const;

/**
 * Runs one checklist over a diff.
 *
 * Chunking, validation and dedup are the analysis package's, unchanged: a
 * second implementation of "does this quote appear in the diff" is a second
 * place for a model's paraphrase to slip through as evidence.
 */
export async function runOwaspChecklist(
  deps: OwaspRunDeps & { key: ChecklistKey },
): Promise<OwaspRunResult> {
  if (deps.key === 'owasp_llm') {
    const applicability = await owaspLlmApplies(deps.db, deps.workspaceId, deps.repoId);
    if (!applicability.applies) {
      // No scan_run row: this scanner did not run and should not appear to
      // have. The Security tab reads the reason from here rather than from an
      // empty result, so "no SBOM yet" never renders as "not applicable".
      return {
        status: 'skipped',
        scanRunId: null,
        findingsCreated: 0,
        findingsTotal: 0,
        chunks: 0,
        rejected: 0,
        escalations: { met: 0, permitted: 0 },
        skippedReason: applicability.reason,
      };
    }
  }

  const checklist = loadChecklist(deps.key, deps.checklistDir);
  const chunked = chunkDiff(deps.files, KEY_DIMENSION);
  if (chunked.chunks.length === 0) {
    return {
      status: 'skipped',
      scanRunId: null,
      findingsCreated: 0,
      findingsTotal: 0,
      chunks: 0,
      rejected: 0,
      escalations: { met: 0, permitted: 0 },
      skippedReason: 'no_diff',
    };
  }

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: deps.key,
      // The CHECKLIST version, because the checklist is what asked the
      // questions — the model id is recorded per call by the gateway.
      scannerVersion: checklist.version,
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'manual',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  const findings: IncomingFinding[] = [];
  let rejected = 0;
  const escalations = { met: 0, permitted: 0 };
  const models = new Set<string>();

  try {
    // Callers and callees for each chunk (W18-25), read once per run.
    const graph = await readImportGraph(deps.db, deps.workspaceId, deps.repoId);
    for (const chunk of chunked.chunks) {
      // The context rides beside the diff, never inside it: chunk.text is what
      // evidence quotes are validated against.
      const prompt = buildChecklistPrompt(checklist, chunk.text, repoContextFor(graph, chunk).text);
      const result = await deps.gateway.complete(prompt, {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: String(deps.repoId),
          prNumber: deps.prNumber ?? 0,
          dimension: KEY_DIMENSION,
          checklistVersion: checklist.version,
          // What the accounting rows are grouped by (FR-SEC-7): scanner spend
          // must be separable from review spend, or the first question about
          // an LLM bill has no answer.
          initiator: `scanner:${deps.key}`,
        },
      });
      models.add(result.model);

      let parsed;
      try {
        parsed = validateFindings(JSON.parse(result.text), chunk.text);
      } catch (err) {
        if (err instanceof FindingParseError || err instanceof SyntaxError) {
          // A chunk whose output cannot be validated contributes NOTHING and
          // is counted. Salvaging what parses would mean storing findings from
          // a response we know was malformed.
          rejected += 1;
          continue;
        }
        throw err;
      }
      rejected += parsed.rejected.length;

      for (const finding of parsed.findings) {
        const trigger = meetsTrigger({
          dimension: finding.dimension,
          severity: finding.severity,
          confidence: finding.confidence,
        });
        if (trigger) {
          escalations.met += 1;
          // Escalation is DECIDED here and acted on by the existing Tier-3
          // path; without the opt-in it is refused, never downgraded silently.
          if (deps.t3OptIn) escalations.permitted += 1;
        }

        findings.push({
          dimension: KEY_DIMENSION,
          severity: finding.severity,
          confidence: finding.confidence,
          file: finding.file,
          lineStart: finding.line_range[0],
          lineEnd: finding.line_range[1],
          title: finding.title,
          evidenceQuote: finding.evidence_quote,
          rationale: finding.rationale,
          suggestedFix: finding.suggested_fix,
          scannerKey: deps.key,
          // The chaining vocabulary, straight from the checklist's own output
          // contract (§3.5). Stored as an object because that is what the
          // column holds; the chainer reads the keys.
          yields:
            finding.yields.length > 0
              ? Object.fromEntries(finding.yields.map((y) => [y, true]))
              : null,
        });
      }
    }

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: deps.pullRequestId ?? null,
      // Tier 2: a model produced these, and the tier is how a reader knows
      // whether to expect a rule id or a judgement.
      tier: 2,
      findings,
      // No reviewedFiles: a checklist pass sees a diff, not a repository.
      sweepScannerKey: deps.key,
    });

    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'succeeded',
        findingCount: findings.length,
        finishedAt: new Date(),
        toolVersions: {
          checklist: checklist.version,
          // Every model that answered — a run split across chunks can hit more
          // than one host, and "which model said this" is the first question
          // about a finding nobody agrees with.
          models: [...models].sort().join(','),
        },
        /**
         * THE CHECKLIST'S OWN FUNNEL (W16-38).
         *
         * `rejected` — findings the evidence validator threw out because their
         * quote was not verbatim from the diff — was returned to the caller and
         * then dropped. So a run where the model proposed four things and every
         * one was rejected recorded `findingCount: 0` and rendered as
         * "✓ ran clean", identical to a run where the model found nothing.
         *
         * Those are very different facts. The first says the prompt or the
         * validator is wrong and is the only way anyone would learn it; the
         * second is good news. This is the same distinction W16-31 drew between
         * "nothing was scanned" and "ran clean", one layer in.
         *
         * The column already existed for exactly this shape of question — its
         * own comment says "only the dependency scanner writes it; other
         * scanners have no funnel". Now one does, and no migration was needed.
         */
        validationFunnel: {
          chunks: chunked.chunks.length,
          proposed: findings.length + rejected,
          rejected,
          created: persisted.created,
        },
      })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      findingsCreated: persisted.created,
      findingsTotal: findings.length,
      chunks: chunked.chunks.length,
      rejected,
      escalations,
    };
  } catch (err) {
    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'failed',
        error: safeErrorText(err).slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, runId));
    return {
      status: 'failed',
      scanRunId: runId,
      findingsCreated: 0,
      findingsTotal: 0,
      chunks: chunked.chunks.length,
      rejected,
      escalations,
      error: safeErrorText(err),
    };
  }
}
