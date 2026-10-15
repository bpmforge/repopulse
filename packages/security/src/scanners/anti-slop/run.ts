import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import {
  validateFindings,
  FindingParseError,
  mayBeSurfacedLoudly,
  needsVerification,
  verdictToStatus,
  type AnalysisGateway,
  type DiffFile,
} from '@repopulse/analysis';
import { loadChecklist } from '../owasp/checklist.js';
import {
  batchCandidates,
  buildCandidatePrompt,
  candidateFor,
  candidateHaystack,
  selectCandidates,
} from './candidates.js';
import { effectiveStatus, registryStatuses } from '../../rules/shadow.js';
import { docstringInflation, ldrFindings, LDR_FLOOR } from './ldr.js';
import { UNUSED_EXPORT_RULE_ID, unusedExports } from './unused-exports.js';
import { EXCEPTION_FLOW_RULE_ID, exceptionFlows } from './exception-flow.js';
import { REPOSITORY_CRUD_RULE_ID, repositoriesOverCrud } from './repository-crud.js';
import { PHANTOM_MODULE_RULE_ID, PHANTOM_SYMBOL_RULE_ID, phantomRefs } from './phantom-refs.js';
import { DELEGATION_WRAPPER_RULE_ID, delegationWrappers } from './delegation-wrappers.js';
import { SINGLE_IMPL_RULE_ID, singleImplInterfaces } from './single-impl.js';
import { STALE_JSDOC_RULE_ID, staleJsdocParams } from './stale-jsdoc.js';
import {
  NO_ASSERTION_RULE_ID,
  TEST_INTEGRITY_RULE_IDS,
  TAUTOLOGY_RULE_ID,
  testIntegrity,
  type TestIntegrityRuleId,
} from './test-integrity.js';
import { goPhantomRefs, goUnusedExports } from './go-graph.js';
import { pythonPhantomRefs } from './python-graph.js';
import { rustPhantomRefs, rustUnusedItems } from './rust-graph.js';
import {
  prSuppressionFinding,
  SUPPRESSION_CEILING_PER_KLOC,
  SUPPRESSION_DENSITY_RULE_ID,
  suppressionDensity,
} from './suppressions.js';
import { PLACEHOLDER_RULE_ID, placeholderValues } from './placeholder-values.js';
import { COMMENTED_CODE_RULE_ID, commentedOutCode } from './commented-out-code.js';
import {
  DEPRECATED_API_RULE_ID,
  DEPRECATED_API_TABLE_VERSION,
  deprecatedApis,
} from './deprecated-apis.js';
import { asyncSmells, SERIAL_AWAITS_RULE_ID, UNBOUNDED_RETRY_RULE_ID } from './async-smells.js';
import {
  ORPHAN_FLAG_RULE_ID,
  SPECULATIVE_PARAM_RULE_ID,
  speculativeGenerality,
} from './speculative.js';
import { DUPLICATE_PURPOSE_RULE_ID, duplicatePurposeDeps } from './duplicate-deps.js';
import { LIBRARY_REIMPLEMENTATION_RULE_ID, libraryReimplementations } from './library-reimpl.js';
import {
  editableManifest,
  readDeclaredDependencies,
  type DeclaredSet,
} from '../../validation/declared.js';
import { runSemgrepScan } from '../semgrep/scanner.js';
import {
  ANTI_SLOP_PACK_FILE_PREFIX,
  CODE_HEALTH_PACK_DIR,
  DEFAULT_EXCLUDED_GLOBS,
  isExcluded,
  type PackRunner,
} from '../logging/run.js';

// The anti_slop scanner (W9-03, CODE_HEALTH_SUITE.md §1/§4, FR-CH-3).
//
// TWO LAYERS THAT MUST NOT OVERLAP. The deterministic layer (the W9-01 pack
// plus the LDR arithmetic here) answers what a pattern can settle. The T2
// checklist answers only what it cannot — single-implementation interfaces,
// delegation-only wrappers, speculative generalisation. Asking a model about
// something a regex already decided would produce two findings for one problem
// and make the model the authority on the half it is worst at.
//
// Since anti-slop.v2 (W18-10) the layers meet at one seam: the fast lane
// FINDS, the model only JUDGES what it found (candidates.ts). The model never
// sees a diff; it sees each shadow candidate's rule, claim and lines.

export const ANTI_SLOP_SCANNER_KEY = 'anti_slop';

export interface AntiSlopDeps {
  db: Database;
  /**
   * Absent = deterministic layer only (W9-06).
   *
   * The weekly snapshot pass runs without a model on purpose: LDR and
   * docstring inflation are arithmetic and need no gateway, while the
   * judgement layer needs a T2 host, a budget and an initiator — which is a
   * wiring decision about LLM scheduling, not something to improvise inside a
   * cron. A run with no gateway reports judgment: 0 and says why.
   */
  gateway?: AnalysisGateway;
  workspaceId: number;
  repoId: number;
  commitSha: string;
  /**
   * The pull request's diff. Since anti-slop.v2 it is a SCOPE, not model
   * input: candidates are judged only in the files it names. Empty = the
   * snapshot pass, which judges every candidate in the tree.
   */
  files: readonly DiffFile[];
  /**
   * Whole-file sources: the fast lane reads them, and they are where every
   * candidate's evidence comes from. No sources = no candidates = no call.
   */
  sources?: readonly { path: string; source: string }[];
  /**
   * The snapshot read hit no cap and skipped no file (W18-02). Only then can a
   * missing module be called missing; absent = assume it was not complete.
   */
  sourcesComplete?: boolean;
  /**
   * The extracted snapshot, for the dependency-hygiene rules (W18-06), which
   * read the project's manifests. Absent = those rules stay silent: the stored
   * SBOM cannot tell a direct dependency from a transitive one, and guessing
   * from it would flag packages nobody in the project chose.
   */
  snapshotDir?: string;
  /**
   * The snapshot directory, for the W9-01 pack's anti-slop rules (W18-30).
   * Absent = no pack layer: a diff is not a tree, and the PR path has no
   * snapshot to point the engine at.
   */
  targetDir?: string;
  image?: string;
  /** Defaults to runSemgrepScan; see PackRunner. */
  runPack?: PackRunner;
  excludedGlobs?: readonly string[];
  trigger?: 'pr_synced' | 'schedule' | 'manual';
  pullRequestId?: number | null;
  /** Workspace override of SUPPRESSION_CEILING_PER_KLOC (W18-04). */
  suppressionCeiling?: number;
  /** Runs a second, independent judgement. Absent = nothing is surfaced. */
  verify?: (finding: {
    title: string;
    evidenceQuote: string;
    file: string;
  }) => Promise<{ refuted: boolean; reason: string }>;
  checklistDir?: string;
}

export interface AntiSlopResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  deterministic: number;
  /** Of `deterministic`, the `bpm-ch-*` pack findings (W18-30). */
  pack: number;
  /** Pack findings on test, script and fixture paths, dropped. */
  excluded: number;
  judgment: number;
  /** Fast-lane candidates sent to the model (anti-slop.v2). */
  candidates: number;
  /** Candidates left unjudged by the per-run cap — reported, never silent. */
  candidatesCapped: number;
  /** Judgement findings a verifier refuted — kept out, and counted. */
  refuted: number;
  /** Judgement findings nobody could verify: stored, never surfaced loudly. */
  unverified: number;
  findingsCreated: number;
  rejected: number;
  error?: string;
}

/** Slopsquat findings already reported by the secrets/dependency scanners. */
async function existingSlopsquatFiles(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ file: read.findings.file })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.status, ['open', 'confirmed']),
        eq(read.findings.ruleId, 'slopsquat'),
      ),
    );
  return new Set(rows.map((r) => r.file).filter((f): f is string => f !== null));
}

/**
 * Where a rule sits in this workspace's lifecycle (§8.2), and so whether its
 * findings run in shadow.
 *
 * A rule that ships in code starts as a candidate: it runs on real scans with
 * its findings stamped experimental until an admin promotes it on evidence.
 * No registry row means nobody has decided yet, which is the shipped default.
 */
async function shippedRuleStatus(
  db: Database,
  workspaceId: number,
  ruleId: string,
): Promise<'candidate' | 'active' | 'deprecated'> {
  const registry = await registryStatuses(db, workspaceId, [ruleId]);
  return effectiveStatus('candidate', registry.get(ruleId));
}

export async function runAntiSlopScan(deps: AntiSlopDeps): Promise<AntiSlopResult> {
  const checklist = loadChecklist('anti_slop', deps.checklistDir);
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: ANTI_SLOP_SCANNER_KEY,
      scannerVersion: checklist.version,
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'manual',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  const findings: IncomingFinding[] = [];
  let rejected = 0;
  let refuted = 0;
  let unverified = 0;
  let pack = 0;
  let excluded = 0;
  let toolVersions: Record<string, string> | null = null;

  try {
    // ---- Deterministic layer -------------------------------------------
    // Files the dependency scanner already flagged as hallucinated packages
    // are SKIPPED here rather than re-reported: FR-CH-3 says cross-link, and
    // two findings for one package is two triage decisions for one problem.
    const alreadyFlagged = await existingSlopsquatFiles(deps.db, deps.workspaceId, deps.repoId);

    // go.mod rides along with the sources (W18-12) because it is the only map
    // from a Go import path to a directory; it is not code, so the per-file
    // layers never see it.
    const all = (deps.sources ?? []).filter((s) => !alreadyFlagged.has(s.path));
    const isGoMod = (p: string): boolean => p === 'go.mod' || p.endsWith('/go.mod');
    const sources = all.filter((s) => !isGoMod(s.path));
    for (const ldr of ldrFindings(sources)) {
      findings.push({
        dimension: 'slop',
        severity: 1,
        // 5: the ratio is arithmetic. What is arguable is the floor, and the
        // finding carries the counts so that is what gets argued with.
        confidence: 5,
        file: ldr.file,
        lineStart: 1,
        lineEnd: 1,
        title: `Low logic density: ${ldr.file}`,
        evidenceQuote: `LDR ${ldr.ratio} < ${LDR_FLOOR} (logic ${ldr.breakdown.logic}, overhead ${ldr.breakdown.overhead})`,
        rationale: ldr.message,
        suggestedFix: null,
        scannerKey: ANTI_SLOP_SCANNER_KEY,
        ruleId: ldr.ruleId,
        yields: null,
      });
    }

    for (const source of sources) {
      for (const inflation of docstringInflation(source.path, source.source)) {
        findings.push({
          dimension: 'slop',
          severity: 1,
          confidence: 5,
          file: inflation.file,
          lineStart: 1,
          lineEnd: 1,
          title: `Docstring inflation: ${inflation.symbol}`,
          evidenceQuote: `${inflation.docLines} doc lines over ${inflation.implLines} implementation lines`,
          rationale: inflation.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: inflation.ruleId,
          yields: null,
        });
      }
    }
    // Dead exports (W18-01) — whole-tree, so the snapshot pass only: a diff
    // cannot say that nothing else imports a name.
    const unusedStatus = sources.length
      ? await shippedRuleStatus(deps.db, deps.workspaceId, UNUSED_EXPORT_RULE_ID)
      : 'deprecated';
    if (unusedStatus !== 'deprecated') {
      // Rust (W18-14) and Go (W18-12) share the rule id: a dead crate-visible
      // item or an unused internal-package symbol is the same finding as a dead
      // export, and one lifecycle row governs all of them. Go: internal
      // packages only, and only over a complete read.
      const goUnused = goUnusedExports(all, { complete: deps.sourcesComplete === true });
      for (const unused of [...unusedExports(sources), ...rustUnusedItems(sources), ...goUnused]) {
        findings.push({
          dimension: 'slop',
          severity: 1,
          // 4, not 5: two independent signals agree, but a consumer outside
          // this repository is something neither of them can see.
          confidence: 4,
          file: unused.file,
          lineStart: unused.line,
          lineEnd: unused.line,
          title: `Unused export: ${unused.name}`,
          evidenceQuote: unused.declaration,
          rationale: unused.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: unused.ruleId,
          yields: null,
          experimental: unusedStatus !== 'active',
        });
      }
    }
    // Phantom references (W18-02): imports of names or modules the
    // repository does not have. Bugs, not taste — severity 3.
    if (sources.length) {
      const statuses = {
        [PHANTOM_SYMBOL_RULE_ID]: await shippedRuleStatus(
          deps.db,
          deps.workspaceId,
          PHANTOM_SYMBOL_RULE_ID,
        ),
        [PHANTOM_MODULE_RULE_ID]: await shippedRuleStatus(
          deps.db,
          deps.workspaceId,
          PHANTOM_MODULE_RULE_ID,
        ),
      };
      // Python (W18-11) and Rust (W18-14) under the SAME rule ids: a phantom import
      // is one defect whatever language it is written in, and one lifecycle row
      // promotes or retires them all.
      const complete = { complete: deps.sourcesComplete === true };
      for (const ref of [
        ...phantomRefs(sources, complete),
        ...pythonPhantomRefs(sources, complete),
        ...rustPhantomRefs(sources, complete),
        ...goPhantomRefs(all, complete),
      ]) {
        const status = statuses[ref.ruleId];
        if (status === 'deprecated') continue;
        findings.push({
          dimension: 'slop',
          severity: 3,
          confidence: 5,
          file: ref.file,
          lineStart: ref.line,
          lineEnd: ref.line,
          title:
            ref.name === null
              ? `Import of a missing module: ${ref.specifier}`
              : ref.file.endsWith('.go')
                ? `Reference to a name that does not exist: ${ref.name} in ${ref.specifier}`
                : `Import of a name that does not exist: ${ref.name} from ${ref.specifier}`,
          evidenceQuote: ref.statement,
          rationale: ref.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: ref.ruleId,
          yields: null,
          experimental: status !== 'active',
        });
      }
    }
    // Structural slop (W18-05): delegation-only wrappers, single-implementation
    // interfaces, stale JSDoc parameters — shapes the T2 checklist used to be
    // asked about. Whole-file and, for the interface count, whole-tree, so the
    // snapshot pass only; the interface rule also needs a complete read, since
    // the second implementation could be in a file the reader skipped.
    // Tests that test nothing (W18-03). Stored under test_coverage, not slop:
    // what they cost is coverage that is not there, and that is the facet a
    // reader looks under. Severity stays at or below 2 — a hollow test hides
    // a bug, it is not one.
    if (sources.length) {
      const statuses = new Map<TestIntegrityRuleId, 'candidate' | 'active' | 'deprecated'>();
      for (const ruleId of TEST_INTEGRITY_RULE_IDS) {
        statuses.set(ruleId, await shippedRuleStatus(deps.db, deps.workspaceId, ruleId));
      }
      const live = TEST_INTEGRITY_RULE_IDS.filter((r) => statuses.get(r) !== 'deprecated');
      for (const t of live.length ? testIntegrity(sources) : []) {
        const status = statuses.get(t.ruleId);
        if (status === 'deprecated') continue;
        findings.push({
          dimension: 'test_coverage',
          // A test with no assertion may be a deliberate smoke test the title
          // does not admit to; the other three are wrong whatever was meant.
          severity: t.ruleId === NO_ASSERTION_RULE_ID ? 1 : 2,
          // A literal compared with itself is arithmetic; the rest read intent
          // off a file and can miss a helper the snapshot did not contain.
          confidence: t.ruleId === TAUTOLOGY_RULE_ID ? 5 : 4,
          file: t.file,
          lineStart: t.line,
          lineEnd: t.line,
          title: t.title,
          evidenceQuote: t.evidence,
          rationale: t.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: t.ruleId,
          yields: null,
          experimental: status !== 'active',
        });
      }
    }
    // Async smells and speculative generality (W18-08). Whole files, so the
    // snapshot pass only; the speculative pair also needs every caller and
    // every read, which only the whole tree has. All four are medium-noise
    // shapes (mechanical-checks plan, batch 2): candidates until promoted.
    if (sources.length) {
      const ids = [
        SERIAL_AWAITS_RULE_ID,
        UNBOUNDED_RETRY_RULE_ID,
        SPECULATIVE_PARAM_RULE_ID,
        ORPHAN_FLAG_RULE_ID,
      ] as const;
      const statuses = new Map(
        await Promise.all(
          ids.map(
            async (id) => [id, await shippedRuleStatus(deps.db, deps.workspaceId, id)] as const,
          ),
        ),
      );
      for (const smell of asyncSmells(sources)) {
        const status = statuses.get(smell.ruleId);
        if (status === 'deprecated') continue;
        const serial = smell.ruleId === SERIAL_AWAITS_RULE_ID;
        findings.push({
          // Serial awaits cost latency, not readability: they belong in the
          // performance facet beside the await-in-loop rule.
          dimension: serial ? 'performance' : 'slop',
          // A retry with no bound turns an outage into a tight loop against
          // the thing that is down — worse than taste, so one step up.
          severity: serial ? 1 : 2,
          // 3: the shape is matched exactly, but whether the reads may run
          // together, or the loop can really spin, depends on code the rule
          // did not read.
          confidence: 3,
          file: smell.file,
          lineStart: smell.line,
          lineEnd: smell.lineEnd,
          title: serial
            ? `Independent awaits run one after another (${smell.evidence.split('\n').length})`
            : 'Retry with no attempt limit or backoff',
          evidenceQuote: smell.evidence,
          rationale: smell.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: smell.ruleId,
          yields: null,
          experimental: status !== 'active',
        });
      }
      for (const knob of speculativeGenerality(sources)) {
        const status = statuses.get(knob.ruleId);
        if (status === 'deprecated') continue;
        findings.push({
          dimension: 'slop',
          severity: 1,
          confidence: 3,
          file: knob.file,
          lineStart: knob.line,
          lineEnd: knob.line,
          title:
            knob.ruleId === ORPHAN_FLAG_RULE_ID
              ? `Hard-coded flag read once: ${knob.name}`
              : `Default no caller overrides: ${knob.name}`,
          // Named, because two parameters of one signature share its line and
          // would otherwise collapse into one finding under the dedup key.
          evidenceQuote: `${knob.name}: ${knob.evidence}`,
          rationale: knob.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: knob.ruleId,
          yields: null,
          experimental: status !== 'active',
        });
      }
    }
    // Suppression density (W18-04): a RATE, so one finding for the tree, one
    // per outlier file, and on a pull request one for what the diff adds.
    // Severity 1: silencing a checker hides defects without being one.
    const prMode = deps.trigger === 'pr_synced' && deps.files.length > 0;
    const suppressionStatus =
      sources.length || prMode
        ? await shippedRuleStatus(deps.db, deps.workspaceId, SUPPRESSION_DENSITY_RULE_ID)
        : 'deprecated';
    if (suppressionStatus !== 'deprecated') {
      const ceiling = deps.suppressionCeiling ?? SUPPRESSION_CEILING_PER_KLOC;
      const density = sources.length ? suppressionDensity(sources, ceiling).findings : [];
      for (const found of density) {
        findings.push({
          dimension: 'slop',
          severity: 1,
          // 4, not 5: the arithmetic is exact, but deciding what is a
          // directive is a lexer's call, and lexers have edge cases.
          confidence: 4,
          file: found.file,
          // Line 1, not the first hit: the finding is about the file's rate,
          // and a key that moved with its first suppression would re-open it.
          lineStart: found.file === null ? null : 1,
          lineEnd: found.file === null ? null : 1,
          title:
            found.file === null
              ? `Checker suppressions at ${found.perKloc} per KLOC across the repository`
              : `Checker suppressions concentrated in ${found.file}`,
          // Digits are stripped from the dedup key, so the row survives the
          // density moving; the counts live in the rationale. Always one
          // decimal: the normaliser keeps the `.`, and `99.5` against `100`
          // would otherwise be two keys for one finding.
          evidenceQuote:
            found.file === null
              ? `suppression density ${found.perKloc.toFixed(1)}/KLOC over the ceiling (repository)`
              : `suppression density ${found.perKloc.toFixed(1)}/KLOC in ${found.file}`,
          rationale: found.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: found.ruleId,
          yields: null,
          experimental: suppressionStatus !== 'active',
        });
      }
      const added = prMode ? prSuppressionFinding(deps.files, ceiling) : null;
      if (added) {
        findings.push({
          dimension: 'slop',
          severity: 1,
          confidence: 4,
          file: null,
          lineStart: null,
          lineEnd: null,
          title: `This change adds ${added.hits} checker suppressions`,
          // `pr-<id>` keeps its digits through the key normaliser (a token with
          // a letter is an identifier), so two pull requests stay two findings.
          evidenceQuote: `suppressions added in pr-${deps.pullRequestId ?? 'unknown'}: ${added.perKloc.toFixed(1)}/KLOC of added code`,
          rationale: added.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: added.ruleId,
          yields: null,
          experimental: suppressionStatus !== 'active',
        });
      }
    }
    // Exception control flow and repository-over-CRUD (W18-09): structural
    // smells, not bugs — severity 1, and in shadow until promoted on evidence.
    // Both are per-file shapes, so they need sources but not a complete read.
    if (sources.length) {
      const flowStatus = await shippedRuleStatus(deps.db, deps.workspaceId, EXCEPTION_FLOW_RULE_ID);
      if (flowStatus !== 'deprecated') {
        for (const flow of exceptionFlows(sources)) {
          findings.push({
            dimension: 'slop',
            severity: 1,
            // 4: that the throw is caught locally is read from the structure;
            // whether the branch should be an if is the arguable half.
            confidence: 4,
            file: flow.file,
            lineStart: flow.line,
            lineEnd: flow.line,
            title: `Exception used as control flow (caught on line ${flow.handlerLine})`,
            evidenceQuote: flow.statement,
            rationale: flow.message,
            suggestedFix: null,
            scannerKey: ANTI_SLOP_SCANNER_KEY,
            ruleId: flow.ruleId,
            yields: null,
            experimental: flowStatus !== 'active',
          });
        }
      }
      const crudStatus = await shippedRuleStatus(
        deps.db,
        deps.workspaceId,
        REPOSITORY_CRUD_RULE_ID,
      );
      if (crudStatus !== 'deprecated') {
        for (const repo of repositoriesOverCrud(sources)) {
          findings.push({
            dimension: 'slop',
            severity: 1,
            // 3: every method forwarding is a fact; whether the layer is
            // pulling its weight elsewhere (a test seam, a port) is not.
            confidence: 3,
            file: repo.file,
            lineStart: repo.line,
            lineEnd: repo.line,
            title: `Repository over CRUD: ${repo.className}`,
            evidenceQuote: repo.declaration,
            rationale: repo.message,
            suggestedFix: null,
            scannerKey: ANTI_SLOP_SCANNER_KEY,
            ruleId: repo.ruleId,
            yields: null,
            experimental: crudStatus !== 'active',
          });
        }
      }
    }
    // Leftover content (W18-07): placeholder values, commented-out code and
    // deprecated APIs. Per-file reads, so they need no complete snapshot, but
    // they read whole files, so the snapshot pass only. All three land as
    // candidates — the measured precision is in the W18-07 plan note.
    if (sources.length) {
      const leftoverStatus = async (ruleId: string) =>
        shippedRuleStatus(deps.db, deps.workspaceId, ruleId);
      const placeholderStatus = await leftoverStatus(PLACEHOLDER_RULE_ID);
      if (placeholderStatus !== 'deprecated') {
        for (const p of placeholderValues(sources)) {
          findings.push({
            dimension: 'slop',
            // 2: a value nobody replaced fails at the first real request, or —
            // a guessable password — works when it should not.
            severity: 2,
            confidence: 4,
            file: p.file,
            lineStart: p.line,
            lineEnd: p.line,
            title: `Placeholder value in shipped code: ${p.literal.slice(0, 80)}`,
            evidenceQuote: p.literal,
            rationale: p.message,
            suggestedFix: null,
            scannerKey: ANTI_SLOP_SCANNER_KEY,
            ruleId: p.ruleId,
            yields: null,
            experimental: placeholderStatus !== 'active',
          });
        }
      }
      const commentedStatus = await leftoverStatus(COMMENTED_CODE_RULE_ID);
      if (commentedStatus !== 'deprecated') {
        for (const c of commentedOutCode(sources)) {
          findings.push({
            dimension: 'slop',
            severity: 1,
            confidence: 4,
            file: c.file,
            lineStart: c.line,
            lineEnd: c.lineEnd,
            title: `Commented-out code: ${c.codeLines} lines`,
            evidenceQuote: c.firstLine,
            rationale: c.message,
            suggestedFix: null,
            scannerKey: ANTI_SLOP_SCANNER_KEY,
            ruleId: c.ruleId,
            yields: null,
            experimental: commentedStatus !== 'active',
          });
        }
      }
      const deprecatedStatus = await leftoverStatus(DEPRECATED_API_RULE_ID);
      if (deprecatedStatus !== 'deprecated') {
        for (const d of deprecatedApis(sources)) {
          findings.push({
            dimension: 'slop',
            severity: 2,
            // 5 from the table; 4 where the deprecation depends on runtime
            // state the text only approximates (a running event loop).
            confidence: d.entry.judge ? 4 : 5,
            file: d.file,
            lineStart: d.line,
            lineEnd: d.line,
            title: `Deprecated API: ${d.entry.id}`,
            evidenceQuote: d.statement,
            rationale: `${d.message} (${DEPRECATED_API_TABLE_VERSION})`,
            suggestedFix: `Use ${d.entry.replacement}.`,
            scannerKey: ANTI_SLOP_SCANNER_KEY,
            ruleId: d.ruleId,
            yields: null,
            experimental: deprecatedStatus !== 'active',
          });
        }
      }
    }
    // Structural slop (W18-05): delegation-only wrappers, single-implementation
    // interfaces, stale JSDoc parameters — shapes the T2 checklist used to be
    // asked about. Whole-file and, for the interface count, whole-tree, so the
    // snapshot pass only; the interface rule also needs a complete read, since
    // the second implementation could be in a file the reader skipped.
    if (sources.length) {
      const structural: (Omit<IncomingFinding, 'experimental'> & { ruleId: string })[] = [];
      for (const w of delegationWrappers(sources)) {
        structural.push({
          dimension: 'slop',
          severity: 1,
          confidence: 5,
          file: w.file,
          lineStart: w.line,
          lineEnd: w.line,
          title: `Delegation-only wrapper: ${w.name}`,
          evidenceQuote: w.declaration,
          rationale: w.message,
          suggestedFix: `Call ${w.callee} directly.`,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: w.ruleId,
          yields: null,
        });
      }
      for (const single of singleImplInterfaces(sources, {
        complete: deps.sourcesComplete === true,
      })) {
        structural.push({
          dimension: 'slop',
          severity: 1,
          // 4: the count is exact over this repository; an implementation in
          // a consumer's repository is the one thing it cannot see.
          confidence: 4,
          file: single.file,
          lineStart: single.line,
          lineEnd: single.line,
          title: `Single-implementation ${single.kind}: ${single.name}`,
          evidenceQuote: single.declaration,
          rationale: single.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: single.ruleId,
          yields: null,
        });
      }
      for (const d of staleJsdocParams(sources)) {
        structural.push({
          dimension: 'slop',
          // 2, not 1: a wrong doc is believed, which makes it worse than a
          // missing one — but it is still documentation, not behaviour.
          severity: 2,
          confidence: 5,
          file: d.file,
          lineStart: d.line,
          lineEnd: d.line,
          title: `Stale JSDoc @param: ${d.stale.join(', ')}${d.name ? ` on ${d.name}` : ''}`,
          evidenceQuote: d.tag,
          rationale: d.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: d.ruleId,
          yields: null,
        });
      }
      const statuses = new Map<string, Awaited<ReturnType<typeof shippedRuleStatus>>>();
      for (const ruleId of [DELEGATION_WRAPPER_RULE_ID, SINGLE_IMPL_RULE_ID, STALE_JSDOC_RULE_ID]) {
        statuses.set(ruleId, await shippedRuleStatus(deps.db, deps.workspaceId, ruleId));
      }
      for (const finding of structural) {
        const status = statuses.get(finding.ruleId);
        if (status === 'deprecated') continue;
        findings.push({ ...finding, experimental: status !== 'active' });
      }
    }
    // Dependency hygiene (W18-06): the project's declared dependencies,
    // read once for both rules.
    if (deps.snapshotDir) {
      const declared = readDeclaredDependencies(deps.snapshotDir);
      findings.push(...(await dependencyHygieneFindings(deps, declared, sources)));
    }
    // ---- The W9-01 pack, anti-slop rules only (W18-30) -------------------
    // Eight rules that were loaded on every weekly run — by the LOGGING
    // scanner, which dropped them by id — and stored by nobody, while the
    // Code Health tab filtered on `bpm-ch-` waiting for them. They belong here:
    // their dimension is `slop`, and under this scanner key only this
    // scanner's runs can ever own or sweep them.
    if (deps.targetDir) {
      const globs = deps.excludedGlobs ?? DEFAULT_EXCLUDED_GLOBS;
      const result = await (deps.runPack ?? runSemgrepScan)({
        targetDir: deps.targetDir,
        rulepackDir: CODE_HEALTH_PACK_DIR,
        rulepackFiles: (file) => file.startsWith(ANTI_SLOP_PACK_FILE_PREFIX),
        budget: { wallClockMs: 10 * 60 * 1000 },
        ...(deps.image ? { image: deps.image } : {}),
      });
      // Failing the run rather than carrying on with LDR alone: a run that
      // reports `succeeded` with no pack findings is indistinguishable from a
      // repository with no empty catches, and that is the lie W18-30 fixes.
      if (result.status !== 'succeeded') {
        throw new Error(`anti-slop pack run failed: ${result.error ?? result.status}`);
      }
      toolVersions = result.toolVersions;

      for (const finding of result.findings) {
        if (!finding.ruleId.startsWith('bpm-ch-')) continue;
        if (isExcluded(finding.file, globs)) {
          excluded += 1;
          continue;
        }
        pack += 1;
        findings.push({
          dimension: 'slop',
          // The pack tops out at WARNING on purpose; the cap is here so a
          // later rule cannot outrank a vulnerability by mis-tagging itself.
          severity: Math.min(3, finding.severity),
          // 4, not 5: the shape is matched exactly, but several of these
          // rules (try/catch in a loop, what-comments) name their own
          // legitimate exceptions, and the finding cannot see the intent.
          confidence: 4,
          file: finding.file,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          title: finding.title,
          evidenceQuote: `${finding.file}:${finding.lineStart} — ${finding.ruleId}`,
          rationale: finding.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: finding.ruleId,
          yields: null,
        });
      }
    }
    const deterministic = findings.length;

    // ---- Judgement layer (anti-slop.v2, W18-10) -------------------------
    // The model judges the fast lane's shadow candidates, each with its
    // evidence, and nothing else. A pull-request run scopes them to the files
    // its diff touched; the snapshot pass judges the whole tree's candidates.
    const diffPaths = deps.files.length ? new Set(deps.files.map((f) => f.path)) : undefined;
    const selection = deps.gateway
      ? selectCandidates(findings, sources, diffPaths ? { diffPaths } : {})
      : { candidates: [], capped: 0 };
    const batches = batchCandidates(checklist, selection.candidates);
    let judgment = 0;

    for (const batch of batches) {
      const result = await deps.gateway!.complete(buildCandidatePrompt(checklist, batch), {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: String(deps.repoId),
          prNumber: 0,
          // NOT 'slop' (W9-16). This is the GATEWAY's dimension — which Tier-2
          // checklist family the model is being asked to apply — and its union
          // is the four review dimensions, not the finding taxonomy. The
          // findings this call produces are stored as `slop`; the checklist
          // driving it is the code-health one.
          dimension: 'code_health',
          checklistVersion: checklist.version,
          initiator: `scanner:${ANTI_SLOP_SCANNER_KEY}`,
        },
      });

      let parsed;
      try {
        parsed = validateFindings(JSON.parse(result.text), candidateHaystack(batch));
      } catch (err) {
        if (err instanceof FindingParseError || err instanceof SyntaxError) {
          rejected += 1;
          continue;
        }
        throw err;
      }
      rejected += parsed.rejected.length;

      const answered = new Set<string>();
      for (const finding of parsed.findings) {
        // A finding about anything but a listed candidate is the model
        // searching again, and a second finding for one candidate is one
        // problem counted twice: both are rejected, and counted.
        const candidate = candidateFor(finding, batch, answered);
        if (!candidate) {
          rejected += 1;
          continue;
        }
        answered.add(candidate.id);

        // THE VERIFY GATE (FR-ANALYSIS-9). A judgement finding is a second
        // model's opinion away from being an accusation about someone's code,
        // so it does not reach the store until an independent verifier has had
        // the chance to refute it.
        let verifyStatus: 'unverified' | 'confirmed' | 'contradicted' = 'unverified';
        if (deps.verify && needsVerification(finding.severity)) {
          const verdict = await deps.verify({
            title: finding.title,
            evidenceQuote: finding.evidence_quote,
            file: finding.file,
          });
          verifyStatus = verdictToStatus(verdict);
        }

        if (verifyStatus === 'contradicted') {
          // Dropped entirely, not stored quietly: a refuted structural claim
          // is one the product got wrong, and keeping it in a list "for
          // reference" is how a triage queue fills with things nobody trusts.
          refuted += 1;
          continue;
        }
        if (verifyStatus === 'unverified') unverified += 1;

        judgment += 1;
        findings.push({
          // The candidate's facet, not always `slop`: a confirmed serial-await
          // candidate is still a latency problem.
          dimension: candidate.dimension,
          // Capped at 3 regardless of what the model said. Structural slop is
          // not exploitable, and a severity-4 wrapper would outrank a real
          // vulnerability in every list that sorts by severity.
          severity: Math.min(3, finding.severity),
          confidence: finding.confidence,
          file: finding.file,
          lineStart: finding.line_range[0],
          lineEnd: finding.line_range[1],
          title: finding.title,
          evidenceQuote: finding.evidence_quote,
          rationale: finding.rationale,
          suggestedFix: finding.suggested_fix,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: 'slop.judgment',
          yields: null,
        });
      }
    }

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: deps.pullRequestId ?? null,
      // Tier 2 even for the deterministic half of this run: the RUN used a
      // model, and a reader sorting by tier is asking "was a model involved",
      // not "which line of this scanner produced it".
      tier: 2,
      findings,
      sweepScannerKey: ANTI_SLOP_SCANNER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'succeeded',
        findingCount: findings.length,
        finishedAt: new Date(),
        ...(toolVersions ? { toolVersions } : {}),
      })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      deterministic,
      pack,
      excluded,
      judgment,
      candidates: selection.candidates.length,
      candidatesCapped: selection.capped,
      refuted,
      unverified,
      findingsCreated: persisted.created,
      rejected,
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
      deterministic: 0,
      pack: 0,
      excluded,
      judgment: 0,
      candidates: 0,
      candidatesCapped: 0,
      refuted,
      unverified,
      findingsCreated: 0,
      rejected,
      error: safeErrorText(err),
    };
  }
}

async function dependencyHygieneFindings(
  deps: AntiSlopDeps,
  declared: DeclaredSet,
  sources: readonly { path: string; source: string }[],
): Promise<IncomingFinding[]> {
  const out: IncomingFinding[] = [];
  const duplicateStatus = await shippedRuleStatus(
    deps.db,
    deps.workspaceId,
    DUPLICATE_PURPOSE_RULE_ID,
  );
  if (duplicateStatus !== 'deprecated') {
    for (const dup of duplicatePurposeDeps(declared.dependencies)) {
      const file = editableManifest(deps.snapshotDir!, dup.manifest);
      const line = declarationLine(deps.snapshotDir!, file, dup.packages[dup.packages.length - 1]!);
      out.push({
        dimension: 'slop',
        severity: 1,
        // 4: the manifest facts are certain; that two members of a row
        // overlap is the table's claim, and the finding cites the table.
        confidence: 4,
        file,
        lineStart: line,
        lineEnd: line,
        title: `Two libraries for one job (${dup.purpose}): ${dup.packages.join(', ')}`,
        evidenceQuote: `${dup.packages.join(', ')} — direct runtime dependencies in ${file}`,
        rationale: dup.message,
        suggestedFix: null,
        scannerKey: ANTI_SLOP_SCANNER_KEY,
        ruleId: dup.ruleId,
        yields: null,
        experimental: duplicateStatus !== 'active',
      });
    }
  }

  const reimplStatus = sources.length
    ? await shippedRuleStatus(deps.db, deps.workspaceId, LIBRARY_REIMPLEMENTATION_RULE_ID)
    : 'deprecated';
  if (reimplStatus !== 'deprecated') {
    for (const hit of libraryReimplementations(sources, declared.dependencies)) {
      out.push({
        dimension: 'slop',
        severity: 1,
        // 3: the name, the dependency and the mechanism agree, but whether the
        // library's version would do here is a judgement about the call site.
        confidence: 3,
        file: hit.file,
        lineStart: hit.line,
        lineEnd: hit.line,
        title: `Re-implements ${hit.api} from ${hit.dependency}: ${hit.name}`,
        evidenceQuote: hit.declaration,
        rationale: hit.message,
        suggestedFix: null,
        scannerKey: ANTI_SLOP_SCANNER_KEY,
        ruleId: hit.ruleId,
        yields: null,
        experimental: reimplStatus !== 'active',
      });
    }
  }
  return out;
}

/** First manifest line naming the package, for the finding's anchor; 1 if none. */
function declarationLine(snapshotDir: string, manifest: string, name: string): number {
  let text: string;
  try {
    text = readFileSync(path.join(snapshotDir, manifest), 'utf8');
  } catch {
    return 1;
  }
  // Maven's `group:artifact` is written as two tags; the artifact is the
  // distinctive half.
  const needle = name.includes(':') ? name.split(':').pop()! : name;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(`(^|[^\\w@/.-])${escaped}([^\\w/.-]|$)`);
  const index = text.split('\n').findIndex((line) => pattern.test(line));
  return index === -1 ? 1 : index + 1;
}

/** Worst-LDR files first — what the weekly snapshot pass samples. */
export function worstByLdr(
  sources: readonly { path: string; source: string }[],
  limit: number,
): string[] {
  return ldrFindings(sources, 1)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, limit)
    .map((f) => f.file);
}

/** Re-export so a caller can ask whether a finding may be shown loudly. */
export { mayBeSurfacedLoudly };
