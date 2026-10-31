// add-w23-tickets.mjs — append the W23 incremental-scanning tickets to RepoPulse plan.json.
// Idempotent: skips ids that already exist. Run from the repopulse root: node <this file>
import { readFileSync, writeFileSync } from 'node:fs';

const PLAN = 'plan.json';
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
const have = new Set(plan.tickets.map((t) => t.id));
const DOC = 'docs/work/INCREMENTAL_SCAN_PLAN.md';
const base = (id, title, module, write_scope, depends_on, acceptance, wp) => ({
  id, title, phase: 23, module, stories: [], write_scope, depends_on, acceptance,
  status: 'todo',
  notes: [`Spec: ${DOC} ${wp}. Full gate before closing: pnpm lint && pnpm typecheck && pnpm test. Respect CLAUDE.md Law 4 (C1a tarball only) and Law 7 (budgeted client).`],
});

const tickets = [
  base('W23-01', 'Up-to-date short-circuit for weekly and manual scans (scope/base_run_id/data_version on scan_runs, force flag, up_to_date reason)', 'security',
    ['packages/shared/src/db/schema/security/index.ts', 'packages/shared/drizzle/**', 'packages/security/src/framework/**', 'apps/api/src/workers/scan-processor.ts', 'apps/api/src/workers/scan-processor.test.ts', 'apps/api/src/workers/index.ts', 'apps/api/src/routes/runs/**', 'apps/web/src/**', 'docs/SECURITY_SUITE.md', 'docs/CONFIG.md', 'plan.json'],
    [],
    [
      'Migration adds scan_runs.scope text not null default full (full|incremental|skipped), base_run_id bigint null, data_version text null; tenancy test green',
      'packages/security/src/framework/up-to-date.ts isUpToDate(workspaceId, repoId, scannerKey, headSha, toolVersions, dataVersion): true iff a succeeded, non-partial run exists for the same workspace/repo/scanner/commit with deep-equal tool_versions and equal data_version (null = ignore); scanners declare dataVersion() in registry metadata — the framework never branches on scanner key',
      'runSweep consults isUpToDate before calling a weekly/manual runner; when up to date it writes a scan_runs row status succeeded, scope skipped, finding_count = previous count, base_run_id = previous run, and NOTHING_SCANNED gains up_to_date with the agreed wording',
      'ScanJobData gains force?: boolean; POST /runs accepts {force:true} ("Full rescan" checkbox in the run dialog) and returns up_to_date: [...] computed synchronously before enqueueing; coverage table shows scope and "up to date as of <date>" instead of never ran',
      'Tests: second weekly job for same sha/tool versions does not call the runner and writes a skipped row; force calls it; changed tool_versions calls it; a succeeded run in another workspace never counts; route test propagates force',
    ], 'WP-R1 + WP-X9'),

  base('W23-02', 'One snapshot per (repo, sha) per batch — Run scans now fetches one tarball, not one per scanner (C1a amended to "one scan batch")', 'security',
    ['packages/security/src/snapshot/**', 'apps/api/src/routes/runs/**', 'apps/api/src/workers/scan-processor.ts', 'apps/api/src/workers/scan-processor.test.ts', 'apps/api/src/workers/index.ts', 'apps/api/src/workers/*.test.ts', 'docs/ARCHITECTURE.md', 'docs/CONSTRAINTS.md', 'CLAUDE.md', 'plan.json'],
    ['W23-01'],
    [
      'A batch job (mode batch) brackets ONE snapshotForScan and runs every enabled inputs:snapshot scanner inside it, sequentially or bounded-parallel on the read-only dir; per-scanner scan_runs rows are still written; the directory is deleted in finally and the hourly sweeper rule is unchanged',
      'isUpToDate is evaluated per scanner before the batch decides to snapshot; if all are up to date no tarball is fetched',
      'A scanner that throws does not stop the others (NFR-15); its scan_run records the error',
      'Fake-provider test: Run scans now on a repo with 5 snapshot scanners -> fetchTarball called exactly once, 5 scan_runs rows, SNAPSHOT_ROOT empty afterwards; forge budget shows one tarball charge',
      'docs/CONSTRAINTS.md C1a reads "for the length of one scan batch"; ARCHITECTURE.md 4i updated in the same commit',
    ], 'WP-R2'),

  base('W23-03', 'Incremental mode for per-file snapshot scanners (code_health_tools, semgrep manual/weekly): forge compare, changed files only, carry-forward merge', 'security',
    ['packages/forge/src/**', 'packages/security/src/scanners/code-health/**', 'packages/security/src/scanners/semgrep/**', 'packages/security/src/framework/types.ts', 'packages/insights/src/**', 'apps/api/src/workers/index.ts', 'apps/web/src/**', 'docs/SECURITY_SUITE.md', 'docs/ECOSYSTEMS.md', 'plan.json'],
    ['W23-01'],
    [
      'Step 0 recorded in the commit body: whether owasp "scheduled surface" is a delta, and whether anti_slop is per-file or whole-tree',
      'ForgeProvider exposes compareCommits(base, head) -> {files[], truncated} through the budgeted client for GitHub, Gitea and GitLab with recorded-fixture contract tests (including the >300-files truncated case)',
      'Scanner metadata gains optional incremental: {maxChangedFiles}; before a full run the framework finds the last succeeded non-partial run with equal tool/data versions as baseRun; delta within cap -> fetch only changed files (no tarball), run per-file adapters, carryForward(baseRun.id, unchangedPaths) re-sights prior findings and closes findings in deleted files; scan_runs.scope = incremental, base_run_id set; delta unavailable or over cap -> full',
      'Drift guard: after 10 incremental runs or 30 days since the last full, the next run is full',
      'Tests: base full run with findings in A,B,C; change B -> only B fetched, A and C findings re-sighted with new last_seen, B findings replaced, finding in deleted D closed; over-cap -> scope full; semgrep manual run with a baseline reports filesScanned < tree size',
      'Coverage chip shows "incremental since <sha7> · last full <date>"',
    ], 'WP-R3'),

  base('W23-04', 'Input-hash gating for whole-tree scanners: dependency_cve re-matches the stored SBOM on data refresh, container_image and architecture_register skip when inputs are unchanged', 'security',
    ['packages/security/src/scanners/dependency/**', 'packages/security/src/scanners/image/**', 'packages/security/src/adapters/architecture/**', 'packages/security/src/sync/**', 'packages/security/src/framework/input-hash.ts', 'deploy/scan-db-sync.sh', 'docs/RUNBOOK.md', 'plan.json'],
    ['W23-01'],
    [
      'dependency_cve: manifest/lockfile set hash via the forge contents API (no tarball); hash and data_version unchanged -> up to date; only data_version changed -> re-match the stored security.sboms row for that commit against the new OSV/KEV/EPSS data with no snapshot; manifests changed -> full',
      'container_image gated by hash of Dockerfile*/compose*/.dockerignore plus base-image digest; architecture_register gated by the commit tree sha',
      'scan-db-sync.sh writes the data stamp the gates read; RUNBOOK.md documents it',
      'Tests for all three gates: unchanged -> skipped row; data_version change -> SBOM re-matched and fetchTarball never called; manifest change -> full',
    ], 'WP-R4'),

  base('W23-05', 'Secrets history sweep resumes from the last swept commit (verify first)', 'security',
    ['packages/security/src/scanners/secrets/history.ts', 'packages/security/src/scanners/secrets/history.test.ts', 'plan.json'],
    [],
    [
      'Step 0 recorded: whether commits with a succeeded secrets scan_runs row are already skipped; if yes, close with that evidence and no code change',
      'Otherwise the 12-month window excludes commits already covered by a succeeded row for scanner_key secrets; force overrides',
      'Test: second sweep over an unchanged history fetches zero patches',
    ], 'WP-R5'),

  base('W23-06', 'Cacheable prompt prefix for Tier-2/3 calls + cache-hit telemetry on the Models page', 'analysis',
    ['packages/analysis/src/t2/**', 'packages/analysis/src/t3/**', 'packages/analysis/src/chunker/**', 'packages/analysis/src/providers/**', 'packages/analysis/src/gateway/**', 'apps/api/src/routes/models/**', 'apps/web/src/**', 'docs/design/ANALYSIS_TIERS.md', 'plan.json'],
    [],
    [
      'Every T2/T3 request is [static block: checklist + schema + rules] + [dynamic block: PR context + diff chunk]; static block sent as system for OpenAI-compatible/LM Studio and as the first content block with cache_control ephemeral for Anthropic/Bedrock/Vertex',
      'Static block is byte-identical across chunks of one dimension (test asserts hash equality)',
      'Gateway usage records cacheReadTokens per call (claude-cli already sums cache_read_input_tokens); Models settings page shows cache hit % per model',
      'Live LM Studio integration test (skipped without infra) shows warm-call latency < 60% of cold for the same dimension; pnpm test green',
    ], 'WP-X7'),

  base('W23-07', 'Incremental re-review on a new push: review only hunks changed between the prior reviewed head and the new head, carry forward surviving findings', 'analysis',
    ['packages/analysis/src/scheduling/**', 'apps/api/src/workers/ai-pass-processor.ts', 'apps/api/src/workers/ai-pass-processor.test.ts', 'apps/api/src/workers/index.ts', 'packages/insights/src/**', 'packages/forge/src/**', 'apps/web/src/**', 'docs/design/ANALYSIS_TIERS.md', 'plan.json'],
    ['W23-03'],
    [
      'When a review for the same PR and dimension exists at an earlier head with the same prompt version, the diff is restricted to files/hunks changed between the two heads (compareCommits from W23-03); only those chunks go to the gateway',
      'Prior findings whose quoted lines still appear in the new full diff are carried forward with new last_seen; the rest are closed; the run is marked scope incremental with base_run_id',
      'Full review when there is no prior, the prompt version changed, or compare is unavailable',
      'Test: PR with 10 files reviewed at head A; push touching 1 file -> exactly that file\'s chunks reach the gateway, 9 files\' findings carried forward, a vanished quote closes its finding; UI shows "incremental since <sha7>"',
    ], 'WP-X8'),

  base('W23-08', 'Surface scan scope everywhere: coverage table, Full rescan control, docs, STATUS, e2e', 'web',
    ['apps/web/src/**', 'e2e/scan-scope.spec.ts', 'e2e/code-health.spec.ts', 'docs/SECURITY_SUITE.md', 'docs/RUNNING.md', 'docs/STATUS.md', 'docs/design/**', 'plan.json'],
    ['W23-01', 'W23-02', 'W23-03', 'W23-04'],
    [
      'Security tab coverage table has a scope column, a "last full" tooltip and the Full rescan control',
      'Playwright: two Run scans now presses with no new commit -> second shows Up to date rows and created no tarball traffic (budget counter or logs); a11y spec green',
      'docs updated; STATUS.md records W23 exit',
    ], 'WP-R6'),
];

let added = 0;
for (const t of tickets) {
  if (have.has(t.id)) continue;
  plan.tickets.push(t);
  added++;
}
writeFileSync(PLAN, JSON.stringify(plan, null, 2) + '\n');
console.log(`added ${added} W23 tickets (${plan.tickets.length} total)`);
