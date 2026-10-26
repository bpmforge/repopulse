import { and, eq, inArray } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { attachExcerpts } from '../../excerpt.js';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { listTreeFiles, snapshotForScan } from '../../snapshot/index.js';
import { runCodeHealthTools, CODE_HEALTH_SCANNER_KEY, type CodeHealthFinding } from './tools.js';
import { dedupeAcrossTools, dedupeAgainstPack, listAdapters } from './adapters/registry.js';
import type { AdapterFinding } from './adapters/types.js';
import type { CodeHealthThresholds } from './thresholds.js';
import { isStarterRule, toolRowIsAdminChoice } from '../../rules/starter-set.js';

// code_health_tools run modes (W9-02, FR-CH-2, FR-SEC-9).
//
// Weekly over a snapshot, or on demand. Not on pull requests: complexity and
// duplication are properties of a codebase, not of a change, and a per-PR run
// would report the same 400 findings on every branch until people filtered the
// scanner out of their view entirely.

export interface CodeHealthRunDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  commitSha: string;
  image?: string;
  thresholds?: Partial<CodeHealthThresholds>;
  trigger?: 'schedule' | 'manual';
  wallClockMs?: number;
}

export interface CodeHealthRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  findingsCreated: number;
  findingsTotal: number;
  metricsWritten: number;
  /** Tool-adapter findings kept after dedup, and those a pack rule already had. */
  adapterFindings?: number;
  adapterDropped?: number;
  /** Adapters that applied but could not be read — surfaced, never swallowed. */
  adapterErrors?: { adapter: string; reason: string }[];
  error?: string;
}

const DEFAULT_IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';
const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;

function toIncoming(findings: readonly CodeHealthFinding[]): IncomingFinding[] {
  return findings.map((f) => ({
    dimension: 'code_health',
    severity: f.severity,
    // 5: these are MEASUREMENTS. A cyclomatic complexity of 23 is not an
    // opinion, and the confidence should say so — what is arguable is the
    // threshold, which the finding states alongside the number.
    confidence: 5,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    title: f.title,
    evidenceQuote: `${f.file}:${f.lineStart} — measured ${f.measured}, threshold ${f.threshold}`,
    rationale: f.message,
    suggestedFix: null,
    scannerKey: CODE_HEALTH_SCANNER_KEY,
    ruleId: f.ruleId,
    // No yields: complexity hands an attacker nothing. A rule that claimed
    // otherwise would put noise into the chainer, and a chain built on
    // "this function is long" is the kind nobody believes twice.
    yields: null,
  }));
}

/**
 * Tool-adapter findings, as stored findings (W9-08 wiring).
 *
 * CONFIDENCE 4, not the 5 our own measurements carry: a lint rule is a
 * heuristic about a pattern, where a cyclomatic complexity of 23 is a count.
 * The rule id keeps the tool's namespace (`tool.ruff.E722`) so a reader can
 * tell whose opinion they are reading, and so the FP rate accumulates against
 * the tool rather than against us.
 */
export function adapterToIncoming(
  findings: readonly AdapterFinding[],
  shadow: ReadonlyMap<AdapterFinding, boolean> = new Map(),
): IncomingFinding[] {
  return findings.map((f) => ({
    dimension: f.dimension === 'correctness' ? 'code_health' : f.dimension,
    severity: f.severity,
    confidence: 4,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    title: f.title,
    evidenceQuote: `${f.file}:${f.lineStart} — ${f.message}`,
    rationale: f.message,
    suggestedFix: null,
    scannerKey: CODE_HEALTH_SCANNER_KEY,
    ruleId: f.ruleId,
    yields: null,
    // Only stated for shadow adapters: ruff and Biome have no lifecycle
    // opinion, and stating `false` for them would un-shadow nothing while
    // implying a decision nobody made.
    ...(shadow.has(f) ? { experimental: shadow.get(f) === true } : {}),
  }));
}

/**
 * Shadow mode for tool adapters that opt in (W18-26, §8.2).
 *
 * The same lookup anti-slop's in-process rules use (shippedRuleStatus), at two
 * granularities: a rule_registry row for the exact rule (`tool.checkov.CKV_AWS_24`)
 * wins; failing that, a row for the whole tool (`tool.checkov`) applies, so an
 * admin can promote sixty checkov checks with one decision; failing both, the
 * shipped default is `candidate`. `active` → live finding, `deprecated` →
 * dropped, anything else → stored with experimental: true.
 *
 * W21-04: a rule in the starter set (rules/starter-set.ts) ships `active`
 * instead. An admin still decides: its own row wins, and so does a tool row
 * an admin has acted on. The tool row the scan seeds itself (W20-08, a
 * candidate with nobody's name on it) is the old default made visible, not a
 * decision, so it does not hold a starter rule back.
 *
 * Follow-up, deliberately not done here: the YAML `lifecycle` field
 * (rules/shadow.ts on the java-pack branch) is the long-term home for a
 * per-rule shipped default; when it lands, adapter rules should read their
 * default from the same place instead of assuming `candidate`.
 */
export async function adapterShadowState(
  db: Database,
  workspaceId: number,
  findings: readonly AdapterFinding[],
): Promise<{ kept: AdapterFinding[]; experimental: Map<AdapterFinding, boolean> }> {
  const shadowKeys = new Set(
    listAdapters()
      .filter((a) => a.shadow)
      .map((a) => a.key),
  );
  const toolOf = (ruleId: string): string => ruleId.split('.')[1] ?? '';
  const shadowed = findings.filter((f) => shadowKeys.has(toolOf(f.ruleId)));
  const experimental = new Map<AdapterFinding, boolean>();
  if (shadowed.length === 0) return { kept: [...findings], experimental };

  const ids = new Set<string>();
  for (const f of shadowed) {
    ids.add(f.ruleId);
    ids.add(`tool.${toolOf(f.ruleId)}`);
  }
  const rows = await db
    .select({
      ruleId: security.ruleRegistry.ruleId,
      status: security.ruleRegistry.status,
      updatedBy: security.ruleRegistry.updatedBy,
    })
    .from(security.ruleRegistry)
    .where(
      and(
        eq(security.ruleRegistry.workspaceId, workspaceId),
        inArray(security.ruleRegistry.ruleId, [...ids]),
      ),
    );
  const rowOf = new Map(rows.map((r) => [r.ruleId, r]));
  const statusFor = (ruleId: string): string => {
    const own = rowOf.get(ruleId);
    if (own) return own.status;
    const tool = rowOf.get(`tool.${toolOf(ruleId)}`);
    if (isStarterRule(ruleId) && (!tool || !toolRowIsAdminChoice(tool))) return 'active';
    return tool?.status ?? 'candidate';
  };

  const kept: AdapterFinding[] = [];
  for (const f of findings) {
    if (!shadowKeys.has(toolOf(f.ruleId))) {
      kept.push(f);
      continue;
    }
    const status = statusFor(f.ruleId);
    if (status === 'deprecated') continue;
    experimental.set(f, status !== 'active');
    kept.push(f);
  }
  return { kept, experimental };
}

/**
 * A registry row for each shadow adapter tool that raised findings (W20-08,
 * UX_TODO FND-59).
 *
 * IaC findings leave shadow only when a `tool.<tool>` row is active, and
 * nothing ever created one, so Settings → Rules never listed checkov, hadolint,
 * actionlint or shellcheck and there was nothing to promote. The row is seeded
 * as a CANDIDATE with its shadow clock started: exactly the state the shipped
 * default already implied, now visible. Promotion is still an admin's action
 * behind the existing gate (20 findings, 30 days, under 20% false positives);
 * an existing row, whatever its status, is never touched.
 */
export async function seedAdapterRegistry(
  db: Database,
  workspaceId: number,
  findings: readonly AdapterFinding[],
  now = new Date(),
): Promise<string[]> {
  const shadowKeys = new Set(
    listAdapters()
      .filter((a) => a.shadow)
      .map((a) => a.key),
  );
  const tools = [
    ...new Set(
      findings.map((f) => f.ruleId.split('.')[1] ?? '').filter((tool) => shadowKeys.has(tool)),
    ),
  ];
  if (tools.length === 0) return [];
  const inserted = await db
    .insert(security.ruleRegistry)
    .values(
      tools.map((tool) => ({
        workspaceId,
        ruleId: `tool.${tool}`,
        status: 'candidate',
        shadowStartedAt: now,
        provenance: {
          source: `adapter:${tool}`,
          // The mapping from the tool's output to findings is ours; the tool
          // runs unmodified in the sandbox and none of its rule text is stored.
          license: 'UNLICENSED-REPOPULSE',
          author: 'repopulse',
          date: now.toISOString().slice(0, 10),
        },
      })),
    )
    .onConflictDoNothing()
    .returning({ ruleId: security.ruleRegistry.ruleId });
  return inserted.map((r) => r.ruleId);
}

/** Weekly/manual pass over a snapshot. */
export async function runCodeHealthScan(deps: CodeHealthRunDeps): Promise<CodeHealthRunResult> {
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: CODE_HEALTH_SCANNER_KEY,
      scannerVersion: 'pending',
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'schedule',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  try {
    return await snapshotForScan(
      { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
      async (snapshot) => {
        const tools = await runCodeHealthTools({
          targetDir: snapshot.dir,
          image: deps.image ?? DEFAULT_IMAGE,
          budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
          ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
        });

        if (tools.status !== 'succeeded') {
          await closeRun(deps.db, runId, 'failed', 0, tools.error ?? null, tools.toolVersions);
          return {
            status: 'failed' as const,
            scanRunId: runId,
            findingsCreated: 0,
            findingsTotal: 0,
            metricsWritten: 0,
            ...(tools.error ? { error: tools.error } : {}),
          };
        }

        // DEDUPE AGAINST THE PACK RULES ALREADY OPEN FOR THIS REPO, not just
        // against this run: the mapping that matters is ruff's E722 losing to
        // our bpm-ch-empty-catch, and that rule belongs to a different scanner
        // whose findings are already stored. Deduping against this run alone
        // would keep both and hand a reader two rows for one defect.
        const openRuleIds = (
          await deps.db
            .select({ ruleId: read.findings.ruleId })
            .from(read.findings)
            .where(eq(read.findings.repoId, deps.repoId))
        )
          .map((row) => row.ruleId)
          .filter((id): id is string => id !== null);

        // Tool-vs-tool first (checkov and hadolint on one Dockerfile), then
        // tool-vs-pack. Both before the lifecycle lookup, so a duplicate is
        // never stored just because its rule happens to be in shadow.
        const acrossTools = dedupeAcrossTools(tools.adapterFindings);
        const againstPack = dedupeAgainstPack(acrossTools.kept, openRuleIds);
        const dropped = [...acrossTools.dropped, ...againstPack.dropped];
        const { kept, experimental } = await adapterShadowState(
          deps.db,
          deps.workspaceId,
          againstPack.kept,
        );
        const findings = [...toIncoming(tools.findings), ...adapterToIncoming(kept, experimental)];
        await seedAdapterRegistry(deps.db, deps.workspaceId, kept);
        // W20-08 (UX_TODO FND-48): the whole tree was in front of the tools,
        // so every file in it is reviewed. An adapter that failed saw nothing,
        // and its findings are left exactly as they were.
        const tree = listTreeFiles(snapshot.dir);
        const failedTools = new Set(tools.adapterErrors.map((e) => e.adapter));
        const persisted = await persistFindings(deps.db, {
          workspaceId: deps.workspaceId,
          repoId: deps.repoId,
          scanRunId: runId,
          pullRequestId: null,
          tier: 1,
          findings: await attachExcerpts(snapshot.dir, findings),
          // A snapshot run has seen the whole tree, so it may close what it no
          // longer reports — its own findings only.
          reviewedFiles: [
            ...new Set([...tree, ...findings.map((f) => f.file).filter((f): f is string => !!f)]),
          ],
          fullSweep: {
            treeFiles: tree,
            keepOpen: (row) =>
              row.ruleId !== null &&
              row.ruleId.startsWith('tool.') &&
              failedTools.has(row.ruleId.split('.')[1] ?? ''),
          },
          sweepScannerKey: CODE_HEALTH_SCANNER_KEY,
        });

        // Posture metrics onto the SAME series table every other metric uses,
        // so trends need no new endpoint and no new chart component.
        const metricRows = [
          { key: 'ch_duplication_pct', value: tools.metrics.ch_duplication_pct },
          { key: 'ch_complexity_p90', value: tools.metrics.ch_complexity_p90 },
          { key: 'ch_worst_fn_count', value: tools.metrics.ch_worst_fn_count },
        ].filter((row): row is { key: string; value: number } => row.value !== null);

        if (metricRows.length > 0) {
          await deps.db.insert(read.metricSnapshots).values(
            metricRows.map((row) => ({
              workspaceId: deps.workspaceId,
              repoId: deps.repoId,
              metricKey: row.key,
              // Snapshot metrics describe the tree at one commit, not a
              // window of activity — 'all' says that rather than implying a
              // 30-day measurement nobody made.
              window: 'all',
              value: String(row.value),
              dims: { commit_sha: deps.commitSha, scanner: CODE_HEALTH_SCANNER_KEY },
            })),
          );
        }

        await closeRun(deps.db, runId, 'succeeded', findings.length, null, tools.toolVersions);

        return {
          status: 'succeeded' as const,
          scanRunId: runId,
          findingsCreated: persisted.created,
          findingsTotal: findings.length,
          metricsWritten: metricRows.length,
          adapterFindings: kept.length,
          adapterDropped: dropped.length,
          adapterErrors: tools.adapterErrors,
        };
      },
    );
  } catch (err) {
    await closeRun(deps.db, runId, 'failed', 0, safeErrorText(err).slice(0, 500), null);
    return {
      status: 'failed',
      scanRunId: runId,
      findingsCreated: 0,
      findingsTotal: 0,
      metricsWritten: 0,
      error: safeErrorText(err),
    };
  }
}

async function closeRun(
  db: Database,
  runId: number,
  status: 'succeeded' | 'failed',
  findingCount: number,
  error: string | null,
  toolVersions: Record<string, string> | null,
): Promise<void> {
  await db
    .update(security.scanRuns)
    .set({
      status,
      findingCount,
      error,
      finishedAt: new Date(),
      ...(toolVersions
        ? {
            toolVersions,
            scannerVersion: Object.entries(toolVersions)
              .map(([k, v]) => `${k}@${v}`)
              .join(' '),
          }
        : {}),
    })
    .where(eq(security.scanRuns.id, runId));
}
