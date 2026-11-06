import { and, eq, inArray } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { attachExcerpts } from '../../excerpt.js';
import {
  carryForward,
  filesSeenByRun,
  persistFindings,
  type IncomingFinding,
} from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listTreeFiles, shred, snapshotOrProvided } from '../../snapshot/index.js';
import { ruleStateStamp } from '../../framework/data-stamp.js';
import {
  fetchChangedFiles,
  planIncremental,
  type IncrementalPlan,
} from '../../framework/incremental.js';
import { realToolVersions } from '../../framework/input-hash.js';
import { getScanner } from '../../registry.js';
import { SCAN_MOUNT_PATH } from '../../../sandbox/profile.js';
import {
  runCodeHealthTools,
  codeHealthDataVersion,
  CODE_HEALTH_SCANNER_KEY,
  isOutOfScopeCodeHealth,
  type CodeHealthFinding,
  type ToolRunResult,
} from './tools.js';
import {
  adaptersFor,
  dedupeAcrossTools,
  dedupeAgainstPack,
  listAdapters,
} from './adapters/registry.js';
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
  /** W23-02. A tree the scan batch already fetched; absent = fetch our own. */
  snapshot?: { dir: string; commitSha: string };
  /**
   * W23-03. "Full rescan": never plan an incremental run. Without it, and
   * without a handed-in tree (already on disk, so a full run costs nothing
   * extra), a run with a usable baseline scans only the files changed since it.
   */
  force?: boolean;
  /** Test seams for the incremental path; production leaves them out. */
  runTools?: typeof runCodeHealthTools;
  plan?: typeof planIncremental;
  persist?: typeof persistFindings;
  carry?: typeof carryForward;
  seenFiles?: typeof filesSeenByRun;
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
  /** W23-03: what the run did. Absent = a full run. */
  scope?: 'full' | 'incremental';
  /** Incremental only: changed files actually fetched and scanned. */
  filesScanned?: number;
  /** Incremental only: prior findings re-sighted, and findings closed in deleted files. */
  carriedForward?: number;
  closedInDeletedFiles?: number;
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
          license: 'Apache-2.0',
          author: 'repopulse',
          date: now.toISOString().slice(0, 10),
        },
      })),
    )
    .onConflictDoNothing()
    .returning({ ruleId: security.ruleRegistry.ruleId });
  return inserted.map((r) => r.ruleId);
}

/**
 * Files lizard reads (its languages), broad on purpose: a file fetched that no
 * tool reads costs one contents call, while a file left out that lizard WOULD
 * have measured makes the incremental answer differ from a full run's.
 */
const LIZARD_FILES =
  /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|java|cs|js|jsx|mjs|cjs|vue|ts|tsx|py|rb|php|swift|go|rs|scala|kt|kts|lua|sol|erl|hrl|zig|gd|ttcn|ttcn3|pl|pm|f90|f95|r)$/i;

/** A changed path some per-file tool of this scanner would read (lizard, or an adapter's own filter). */
function isReadable(file: string): boolean {
  return (
    LIZARD_FILES.test(file) || adaptersFor({ mountPath: SCAN_MOUNT_PATH, files: [file] }).length > 0
  );
}

/**
 * INCREMENTAL mode (W23-03, WP-R3): the changed files since the last full
 * answer, fetched one by one (no tarball), run through lizard and the per-file
 * adapters in a scratch dir; the base run's findings for every other file are
 * carried forward. Whole-tree result, incremental work (C12).
 *
 * WHAT IT DOES NOT DO, and why that is stated rather than hidden:
 *   - DUPLICATION (jscpd) is a relation between files; it is not run. Clones
 *     already on record are never closed or replaced by an incremental run
 *     (only deleted files take theirs with them), and the next full run, at most
 *     ten incrementals or thirty days away, recomputes them.
 *   - The three posture metrics (duplication %, complexity p90, worst-function
 *     count) are whole-tree numbers; over a handful of files they would plot a
 *     drop that never happened. No metric rows are written; the series carries
 *     the last full run's values.
 *   - An adapter whose `scope` is not 'file' (cppcheck, checkov, iacrender), in
 *     the last full run or among the changed files, makes the run full.
 *
 * Returns null whenever it cannot be exact: the caller then runs the full scan,
 * and NOTHING has been written (no run row, no finding). The fetch and every
 * check come before the first write.
 */
async function tryIncremental(
  deps: CodeHealthRunDeps,
  dataVersion: string | null,
): Promise<CodeHealthRunResult | null> {
  const meta = getScanner(CODE_HEALTH_SCANNER_KEY)?.incremental;
  if (!meta) return null;

  let plan: IncrementalPlan;
  try {
    plan = await (deps.plan ?? planIncremental)({
      db: deps.db,
      provider: deps.provider,
      repo: deps.repo,
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: CODE_HEALTH_SCANNER_KEY,
      headSha: deps.commitSha,
      // The run's own tool versions are known only by running (which adapters
      // the TREE triggers); the data stamp pins the registry, pins and image.
      dataVersion,
      maxChangedFiles: meta.maxChangedFiles,
    });
  } catch {
    return null;
  }
  if (plan.mode !== 'incremental') return null;

  const treeAdapters = new Set(
    listAdapters()
      .filter((a) => a.scope !== 'file')
      .map((a) => a.key),
  );
  if (Object.keys(plan.baseRun.toolVersions ?? {}).some((k) => treeAdapters.has(k))) return null;
  const targets = plan.changed.filter(isReadable);
  if (adaptersFor({ mountPath: SCAN_MOUNT_PATH, files: targets }).some((a) => a.scope !== 'file')) {
    return null;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'repopulse-code-health-'));
  try {
    let fetched;
    try {
      fetched = await fetchChangedFiles({
        provider: deps.provider,
        repo: deps.repo,
        repoId: deps.repoId,
        commitSha: deps.commitSha,
        paths: targets,
        root,
        maxFiles: meta.maxChangedFiles,
        onMissing: 'skip',
      });
    } catch {
      return null;
    }
    // A file we could not read in full (over the forge's size limit, binary) is
    // one a full run's tarball WOULD have measured: its old findings cannot be
    // carried as if nothing happened, so the exact answer is the full run.
    if (fetched.unreadable.length > 0 || fetched.overCap.length > 0) return null;

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
        scope: 'incremental',
        baseRunId: plan.baseRun.id,
      })
      .returning();
    const runId = run!.id;

    try {
      const emptyTools: ToolRunResult = {
        status: 'succeeded',
        findings: [],
        adapterFindings: [],
        adapterErrors: [],
        metrics: { ch_duplication_pct: 0, ch_complexity_p90: null, ch_worst_fn_count: 0 },
        toolVersions: {},
      };
      const tools: ToolRunResult =
        fetched.written.length === 0
          ? emptyTools
          : await (deps.runTools ?? runCodeHealthTools)({
              targetDir: root,
              image: deps.image ?? DEFAULT_IMAGE,
              budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
              skipDuplication: true,
              ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
            });
      const toolVersions = {
        ...(realToolVersions(plan.baseRun.toolVersions) ?? {}),
        ...tools.toolVersions,
      };

      if (tools.status !== 'succeeded') {
        await closeRun(deps.db, runId, 'failed', 0, tools.error ?? null, toolVersions);
        return {
          status: 'failed',
          scanRunId: runId,
          findingsCreated: 0,
          findingsTotal: 0,
          metricsWritten: 0,
          scope: 'incremental',
          ...(tools.error ? { error: tools.error } : {}),
        };
      }

      // Same dedup and shadow lifecycle as a full run, over the scanned files.
      const openRuleIds = (
        await deps.db
          .select({ ruleId: read.findings.ruleId })
          .from(read.findings)
          .where(eq(read.findings.repoId, deps.repoId))
      )
        .map((row) => row.ruleId)
        .filter((id): id is string => id !== null);
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

      const failedTools = new Set(tools.adapterErrors.map((e) => e.adapter));
      const persisted = await (deps.persist ?? persistFindings)(deps.db, {
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        scanRunId: runId,
        pullRequestId: null,
        tier: 1,
        findings: await attachExcerpts(root, findings),
        // THE INCREMENTAL SWEEP: only the files this run read. No tree list, so
        // nothing outside the changed set can be closed by not being reported.
        reviewedFiles: [
          ...new Set([
            ...fetched.written,
            ...findings.map((f) => f.file).filter((f): f is string => !!f),
          ]),
        ],
        fullSweep: {
          // W27-01: a finding on a non-production file is closed whatever its
          // kind, a clone included: the path alone says it is no longer reported.
          keepOpen: (row) =>
            !isOutOfScopeCodeHealth(row) &&
            row.ruleId !== null &&
            // a clone is a relation between files: only a full run may decide it is gone
            (row.ruleId.startsWith('duplication.') ||
              (row.ruleId.startsWith('tool.') && failedTools.has(row.ruleId.split('.')[1] ?? ''))),
        },
        sweepScannerKey: CODE_HEALTH_SCANNER_KEY,
      });

      // Everything else the base run saw: re-sighted, or closed if its file is gone.
      const deleted = [...new Set([...plan.deleted, ...fetched.gone])];
      const scanned = new Set(fetched.written);
      const seen = await (deps.seenFiles ?? filesSeenByRun)(deps.db, {
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        scannerKey: CODE_HEALTH_SCANNER_KEY,
        runId: plan.baseRun.id,
      });
      const carried = await (deps.carry ?? carryForward)({
        db: deps.db,
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        scannerKey: CODE_HEALTH_SCANNER_KEY,
        baseRunId: plan.baseRun.id,
        newRunId: runId,
        unchangedPaths: seen.filter((f) => !scanned.has(f) && !deleted.includes(f)),
        deletedPaths: deleted,
      });

      await closeRun(
        deps.db,
        runId,
        'succeeded',
        findings.length + carried.resighted,
        null,
        toolVersions,
        tools.adapterErrors.length === 0 ? dataVersion : null,
      );
      return {
        status: 'succeeded',
        scanRunId: runId,
        findingsCreated: persisted.created,
        findingsTotal: findings.length + carried.resighted,
        metricsWritten: 0,
        adapterFindings: kept.length,
        adapterDropped: dropped.length,
        adapterErrors: tools.adapterErrors,
        scope: 'incremental',
        filesScanned: fetched.written.length,
        carriedForward: carried.resighted,
        closedInDeletedFiles: carried.closed,
      };
    } catch (err) {
      await closeRun(deps.db, runId, 'failed', 0, safeErrorText(err).slice(0, 500), null);
      return {
        status: 'failed',
        scanRunId: runId,
        findingsCreated: 0,
        findingsTotal: 0,
        metricsWritten: 0,
        scope: 'incremental',
        error: safeErrorText(err),
      };
    }
  } finally {
    await shred(root);
  }
}

/** Weekly/manual pass over a snapshot. */
export async function runCodeHealthScan(deps: CodeHealthRunDeps): Promise<CodeHealthRunResult> {
  // W23-09: read before the tools run (see semgrep run-modes for why).
  const dataVersion = codeHealthDataVersion(
    deps.thresholds,
    await ruleStateStamp(deps.db, deps.workspaceId),
  );
  if (!deps.force && !deps.snapshot) {
    const incremental = await tryIncremental(deps, dataVersion);
    if (incremental) return incremental;
  }
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
    return await snapshotOrProvided(
      deps.snapshot,
      { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
      async (snapshot) => {
        const tools = await (deps.runTools ?? runCodeHealthTools)({
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
        const persisted = await (deps.persist ?? persistFindings)(deps.db, {
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
          // W27-01: test, fixture, generated and vendored files stay in the
          // tree (and so reviewed), and nothing is reported on them any more,
          // so a finding left on one from an earlier scan closes here as no
          // longer reported. Even when its adapter failed: the path decides.
          fullSweep: {
            treeFiles: tree,
            keepOpen: (row) =>
              !isOutOfScopeCodeHealth(row) &&
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

        await closeRun(
          deps.db,
          runId,
          'succeeded',
          findings.length,
          null,
          tools.toolVersions,
          // An adapter that applied and produced nothing (a missing tool, a
          // crash) leaves a run a repeat press should retry: no stamp, no skip.
          tools.adapterErrors.length === 0 ? dataVersion : null,
        );

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
  dataVersion: string | null = null,
): Promise<void> {
  await db
    .update(security.scanRuns)
    .set({
      status,
      findingCount,
      error,
      finishedAt: new Date(),
      ...(dataVersion ? { dataVersion } : {}),
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
