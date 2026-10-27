import { and, eq } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { snapshotForScan } from '../../snapshot/index.js';
import {
  goReachability,
  goVulnDbDir,
  symbolReachability,
  validateVulnerabilities,
  type ValidationFunnel,
} from '../../validation/index.js';
import {
  loadMaliciousIndex,
  matchMalicious,
  maliciousFinding,
  packagesFromSbom,
} from './malicious.js';
import { adviseFix, readFixGraphs } from './fixpath/index.js';
import { runDependencyTools, vulnDbDir } from './tools.js';
import {
  dependencyFindings,
  DEPENDENCY_SCANNER_KEY,
  type FindingFunnel,
  type PricedIncomingFinding,
} from './findings.js';
import type { MatchFunnel } from './matches.js';
import { runSlopsquatSnapshotScan, type SlopsquatResult } from '../slopsquat/run.js';
import { candidatesFrom } from '../../validation/verify/select.js';
import type { VerifyCandidate } from '../../validation/verify/types.js';

// The dependency scanner, end to end (W8-06, SECURITY_SUITE.md §3.2, FR-SEC-5).
//
// syft over the C1a snapshot produces a CycloneDX SBOM, the SBOM is STORED, and
// grype matches it against the mounted database. The store is not incidental:
// security.sboms has been empty since W8-02 built it, so owasp_llm reports
// 'no_sbom' for every repository and the supply-chain registers skip every run.
// This is the producer both of them were waiting for.
//
// W8-13 ADDED THE VALIDATION FUNNEL between the tools and the store. grype's
// raw output is a wall of CVEs; V0 merges the ones that are one vulnerability
// reported twice, V1 asks the lockfile whether the package ships, V2 asks
// whether anything imports it, V3 asks whether a call graph reaches it, and V4
// prices the result. Every tier's counts come back on the result object, so the
// funnel is reportable rather than a number that shrank for unstated reasons.
//
// SCORING HAPPENS HERE, AT CREATION (V4). persistFindings does not price, and
// repriceFindings — the nightly job that does — builds its PricingInput from
// `kev` and `dep_scope` ONLY. It ignores `epss` and `reachability`, so a
// non-KEV dependency finding would sit at the likelihood FLOOR with its EPSS
// score stored beside it and unread. So this run writes effective_risk itself,
// through the same pure priceFinding, and a test pins the divergence: the
// one-line fix lives in packages/insights/src/risk/reprice.ts, which is outside
// this ticket's write scope, and until it lands the nightly job will flatten
// these scores back. Stated rather than left for someone to discover from a
// score that moved overnight.

export interface DependencyRunDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  commitSha: string;
  image?: string;
  /** Host directory holding the grype database. Defaults to vulnDbDir(). */
  vulnDb?: string;
  /** Host directory holding the Go vulnerability database (V3). */
  goVulnDb?: string;
  trigger?: 'schedule' | 'manual' | 'push' | 'pr_synced';
  wallClockMs?: number;
  /** Host directory of the package-name index (W21-05). Defaults to packageIndexDir(). */
  packageIndexDir?: string;
  /**
   * W21-02. A tree someone else already fetched: the PR scan takes ONE snapshot
   * of a pull request's head and every pattern scanner reads it, so this run
   * makes no forge call of its own. Absent = fetch one, as the weekly pass does.
   */
  snapshot?: { dir: string; commitSha: string };
  /** The pull request a `pr_synced` run is for; stamped on what it creates. */
  pullRequestId?: number | null;
  /**
   * W21-03. The V5 second opinion on this run's CVEs, after they are stored
   * and priced: the caller (the worker) owns which connection may be asked and
   * how many calls are left this month. Never on a PR run. A failure here is
   * reported on the result and never fails the scan.
   */
  verifyCves?: (args: {
    candidates: VerifyCandidate[];
    scanRunId: number;
    commitSha: string;
  }) => Promise<CveVerifySummary>;
}

/** What the V5 second opinion did on one run (W21-03). */
export interface CveVerifySummary {
  asked: number;
  confirmed: number;
  contradicted: number;
  /** Why nobody was asked, when nobody was. */
  refused?: string;
  error?: string;
}

/**
 * The funnel, reported rather than summarised.
 *
 * Every number a reader would need to tell "nothing is wrong here" from "the
 * scan lost things on the way". A scanner that returned only a finding count
 * could hide a database that matched nothing, a tool that emitted half its
 * output, or an ecosystem we silently cannot scope.
 */
export interface DependencyRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  /** Components in the stored SBOM — the document's own count. */
  componentsScanned: number;
  /**
   * Of those, the ones our own reader can scope: npm and pypi purls.
   *
   * Reported separately because the document count includes the root project
   * and a file entry per manifest, so "3 components" for one dependency is a
   * true number that reads as a wrong one.
   */
  syncableComponents: number;
  /** Raw grype matches, before de-duplication. */
  matchesFound: number;
  /** (package, CVE) rows collapsed because two providers reported the same one. */
  duplicatesCollapsed: number;
  /** Matches kept with no resolvable CVE id — reported, never dropped. */
  withoutCveId: number;
  /** Matches whose severity grype could not score; filed at 3, not at 1. */
  unknownSeverity: number;
  /** Vulnerabilities V1 could not place in any resolved dependency set. */
  withoutScope: number;
  /** KEV matches whose severity was floored to 4. */
  kevFloored: number;
  /**
   * The V0-V4 funnel (W8-13, FR-SEC-15).
   *
   * Returned whole rather than flattened into this object: `raw → deduped` is a
   * narrowing and everything after it is a BREAKDOWN of the same population,
   * and mixing the two into one list of numbers is how a reader concludes the
   * scanner dropped findings it never dropped.
   */
  validation: ValidationFunnel | null;
  /** Why V3 proved nothing, when it proved nothing. Never silent. */
  reachabilityNote: string | null;
  /** Malicious-package hits (W18-37), and why the check did not run when it did not. */
  maliciousFound: number;
  maliciousNote: string | null;
  /**
   * The slopsquat pass over the same snapshot (W21-05): its own scan_run and
   * findings under scanner key `slopsquat`, summarised here. Null when it did
   * not run (disabled, or it failed before recording anything).
   */
  slopsquat: Pick<SlopsquatResult, 'status' | 'signals' | 'findingsCreated' | 'notChecked'> | null;
  findingsCreated: number;
  findingsTotal: number;
  /** Findings whose effective_risk this run wrote (V4). */
  findingsPriced: number;
  sbomStored: boolean;
  /** W21-03: the second opinion on this run's CVEs, when one was wired. */
  cveVerify?: CveVerifySummary;
  error?: string;
}

const DEFAULT_IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';
const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;

const emptyFunnel = {
  componentsScanned: 0,
  syncableComponents: 0,
  matchesFound: 0,
  duplicatesCollapsed: 0,
  withoutCveId: 0,
  unknownSeverity: 0,
  withoutScope: 0,
  kevFloored: 0,
  validation: null,
  reachabilityNote: null,
  maliciousFound: 0,
  maliciousNote: null,
  slopsquat: null,
  findingsCreated: 0,
  findingsTotal: 0,
  findingsPriced: 0,
  sbomStored: false,
};

export async function runDependencyScan(deps: DependencyRunDeps): Promise<DependencyRunResult> {
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: DEPENDENCY_SCANNER_KEY,
      scannerVersion: 'pending',
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'schedule',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  // A PULL REQUEST'S RUN IS A LOOK, NOT A SWEEP (W21-02). Its tree is a
  // branch, so it stores no SBOM (the registers and owasp_llm read the newest
  // one as the repository's), closes nothing (a PR that drops a vulnerable
  // package has not fixed the default branch), and stamps the PR on what it
  // creates so the CI pull can call it introduced.
  const prRun = deps.trigger === 'pr_synced';
  const withTree = <T>(fn: (snapshot: { dir: string; commitSha: string }) => Promise<T>) =>
    deps.snapshot
      ? fn(deps.snapshot)
      : snapshotForScan(
          { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
          fn,
        );

  try {
    return await withTree(async (snapshot) => {
      const tools = await runDependencyTools({
        targetDir: snapshot.dir,
        image: deps.image ?? DEFAULT_IMAGE,
        vulnDb: deps.vulnDb ?? vulnDbDir(),
        budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
      });

      // W21-05: slopsquat reads the manifests in this same snapshot, so it
      // costs no fetch. BEFORE the tool check on purpose: it needs neither
      // syft nor grype, and a missing vulnerability database must not also
      // hide a hallucinated package. Its run row and failures are its own.
      // Not on a pull request's run (W21-02): W21-05 already checks a PR
      // head's changed manifests in diff mode beside the secrets stream, so
      // a second, whole-tree look here would double the run and the findings.
      const slopsquat = prRun
        ? null
        : await runSlopsquatSnapshotScan({
            db: deps.db,
            workspaceId: deps.workspaceId,
            repoId: deps.repoId,
            commitSha: snapshot.commitSha,
            snapshotDir: snapshot.dir,
            trigger:
              deps.trigger === undefined || deps.trigger === 'pr_synced'
                ? 'schedule'
                : deps.trigger,
            ...(deps.packageIndexDir ? { indexDir: deps.packageIndexDir } : {}),
          })
            .then((r) =>
              r.status === 'disabled'
                ? null
                : {
                    status: r.status,
                    signals: r.signals,
                    findingsCreated: r.findingsCreated,
                    notChecked: r.notChecked,
                  },
            )
            .catch(() => null);

      if (tools.status !== 'succeeded' || tools.document === null) {
        // RETURN BEFORE persistFindings. A failed tool run reaching the store
        // with an empty findings list would auto-resolve every dependency
        // finding this repository has — a crashed scanner marking real CVEs
        // as fixed. The scan_run row is left failed with the tool's own
        // reason, so "grype found nothing" and "grype did not run" are two
        // visibly different states.
        await closeRun(
          deps.db,
          runId,
          'failed',
          0,
          tools.error ?? 'tool run failed',
          tools.toolVersions,
        );
        return {
          status: 'failed' as const,
          scanRunId: runId,
          ...emptyFunnel,
          slopsquat,
          ...(tools.error ? { error: tools.error } : {}),
        };
      }

      // The SBOM is stored BEFORE the findings, and stored even when there
      // are none: an empty findings list against a real component list is
      // the good result, and it is only legible if the component list is
      // there to read. Upserted because sboms is unique on
      // (workspace, repo, commit) and a re-scan of the same commit is
      // ordinary — the document is regenerated, not accumulated.
      if (!prRun)
        await deps.db
          .insert(security.sboms)
          .values({
            workspaceId: deps.workspaceId,
            repoId: deps.repoId,
            commitSha: snapshot.commitSha,
            format: 'cyclonedx',
            document: tools.document,
            componentCount: tools.componentCount,
            generatedBy: `syft@${tools.toolVersions['syft'] ?? 'unknown'}`,
          })
          .onConflictDoUpdate({
            target: [security.sboms.workspaceId, security.sboms.repoId, security.sboms.commitSha],
            set: {
              document: tools.document,
              componentCount: tools.componentCount,
              generatedBy: `syft@${tools.toolVersions['syft'] ?? 'unknown'}`,
            },
          });

      // V3 runs BEFORE the funnel because its proof is an input to it. It
      // preflights for a Go vulnerability database and a vendored go.mod and
      // returns a stated reason when either is missing, rather than starting
      // a container that would fail — so a JavaScript repository costs
      // nothing here and a Go one says why it was not proven.
      const reachability = await goReachability({
        targetDir: snapshot.dir,
        image: deps.image ?? DEFAULT_IMAGE,
        goVulnDb: deps.goVulnDb ?? goVulnDbDir(),
        budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
      });

      // W18-46: call sites of catalogued vulnerable functions in JS/TS and
      // Python. Costs nothing unless a catalogued package is in this scan.
      const symbols = await symbolReachability({
        targetDir: snapshot.dir,
        matches: tools.matches,
        image: deps.image ?? DEFAULT_IMAGE,
        budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
      });

      const validation = validateVulnerabilities({
        matches: tools.matches,
        snapshotDir: snapshot.dir,
        goReachability: reachability,
        symbolReachability: symbols,
        // grype's OWN count, so `raw → deduped` is the whole narrowing rather
        // than the part of it that happened after the reader had already
        // merged the (purl, CVE) duplicates.
        rawMatchCount: tools.matchFunnel?.rawMatches ?? tools.matches.length,
      });

      // W18-36: lockfile graphs, so a transitive CVE names the direct dependency
      // to bump instead of only the vulnerable package's own fixed version.
      const fixGraphs = readFixGraphs(snapshot.dir).graphs;
      const mapped = dependencyFindings(validation.vulnerabilities, tools.document, (v) =>
        adviseFix(fixGraphs, {
          packageType: v.packageType,
          name: v.packageName,
          version: v.packageVersion,
          fixVersions: v.fixVersions,
        }),
      );

      // W18-37: OpenSSF malicious packages. A hit is its own finding at
      // severity 5; a missing index is a stated note on the run, never a
      // silent "none found".
      // W21-03: the V5 candidates are the VALIDATED vulnerabilities, index-
      // aligned with their prices — taken before the malicious hits join the
      // list, which have no vulnerability behind them.
      let verifyCandidates: VerifyCandidate[] | null = null;
      let cveVerify: CveVerifySummary | undefined;
      if (deps.verifyCves && !prRun) {
        try {
          verifyCandidates = candidatesFrom(validation.vulnerabilities, mapped.priced);
        } catch (err) {
          cveVerify = { asked: 0, confirmed: 0, contradicted: 0, error: safeErrorText(err) };
        }
      }

      const malicious = loadMaliciousIndex();
      const maliciousHits = malicious.ok
        ? matchMalicious(packagesFromSbom(tools.document), malicious.index).map(maliciousFinding)
        : [];
      mapped.priced.push(...maliciousHits);
      mapped.findings.push(...maliciousHits.map((h) => h.finding));

      const persisted = await persistFindings(deps.db, {
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        scanRunId: runId,
        pullRequestId: deps.pullRequestId ?? null,
        tier: 1,
        findings: mapped.findings,
        // The manifests this scan read. A CVE that a later scan of the same
        // manifests no longer reports has been upgraded away, and this is
        // the only signal persistFindings has for closing it — without it a
        // patched dependency stays open forever. Never on a PR run (above).
        ...(prRun ? {} : { reviewedFiles: mapped.reviewedFiles }),
        sweepDimensions: ['dependency'],
        sweepScannerKey: DEPENDENCY_SCANNER_KEY,
      });

      const findingsPriced = await priceStoredFindings(deps, mapped.priced);

      await closeRun(deps.db, runId, 'succeeded', mapped.findings.length, null, {
        ...tools.toolVersions,
        ...(reachability.toolVersion ? { govulncheck: reachability.toolVersion } : {}),
        ...(symbols.toolVersion ? { opengrep: symbols.toolVersion } : {}),
      });

      // The scan is done once its findings are stored; the second opinion
      // runs AFTER the run is closed. Before, the run stayed 'running' while a
      // local model checked CVEs one by one — 20 minutes for six on a 27B
      // model (2026-10-27 walkthrough) — and "Run scans now" stayed locked the
      // whole time. Verdicts land on the stored findings either way; a worker
      // that dies mid-verify leaves them "not independently verified".
      if (deps.verifyCves && verifyCandidates && verifyCandidates.length > 0) {
        try {
          cveVerify = await deps.verifyCves({
            candidates: verifyCandidates,
            scanRunId: runId,
            commitSha: snapshot.commitSha,
          });
        } catch (err) {
          cveVerify = { asked: 0, confirmed: 0, contradicted: 0, error: safeErrorText(err) };
        }
      }

      return {
        status: 'succeeded' as const,
        scanRunId: runId,
        sbomStored: !prRun,
        componentsScanned: tools.componentCount,
        ...funnelNumbers(tools.matchFunnel, mapped.funnel),
        validation: validation.funnel,
        reachabilityNote: reachability.reason,
        maliciousFound: maliciousHits.length,
        maliciousNote: malicious.ok ? null : malicious.reason,
        slopsquat,
        findingsCreated: persisted.created,
        findingsTotal: mapped.findings.length,
        findingsPriced,
        ...(cveVerify ? { cveVerify } : {}),
      };
    });
  } catch (err) {
    await closeRun(deps.db, runId, 'failed', 0, safeErrorText(err).slice(0, 500), null);
    return {
      status: 'failed',
      scanRunId: runId,
      ...emptyFunnel,
      error: safeErrorText(err),
    };
  }
}

/**
 * V4 — writes the score each finding was created with.
 *
 * BY DEDUP KEY, not by scan_run_id. persistFindings returns counts rather than
 * ids, and a finding this run merely BUMPED (seen before, still open) keeps the
 * scan_run_id of the run that created it — so keying on this run would leave
 * every pre-existing finding unpriced, which is most of them on every run after
 * the first.
 *
 * The update is deliberately narrow: effective_risk, its band and its
 * decomposition, and nothing else. Status, triage and occurrence counts belong
 * to persistFindings and to whoever triaged the row.
 */
async function priceStoredFindings(
  deps: DependencyRunDeps,
  priced: readonly PricedIncomingFinding[],
): Promise<number> {
  let updated = 0;
  for (const entry of priced) {
    const rows = await deps.db
      .update(read.findings)
      .set({
        effectiveRisk: String(entry.pricing.effectiveRisk),
        riskBand: entry.pricing.band,
        riskFactors: entry.pricing.riskFactors as unknown as Record<string, unknown>,
      })
      .where(
        and(
          eq(read.findings.workspaceId, deps.workspaceId),
          eq(read.findings.repoId, deps.repoId),
          eq(read.findings.dedupKey, entry.key),
        ),
      )
      .returning({ id: read.findings.id });
    updated += rows.length;
  }
  return updated;
}

function funnelNumbers(
  match: MatchFunnel | null,
  findings: FindingFunnel,
): Pick<
  DependencyRunResult,
  | 'matchesFound'
  | 'duplicatesCollapsed'
  | 'withoutCveId'
  | 'unknownSeverity'
  | 'withoutScope'
  | 'kevFloored'
  | 'syncableComponents'
> {
  return {
    syncableComponents: findings.syncableComponents,
    matchesFound: match?.rawMatches ?? 0,
    duplicatesCollapsed: match?.duplicatesCollapsed ?? 0,
    withoutCveId: match?.withoutCveId ?? 0,
    unknownSeverity: match?.unknownSeverity ?? 0,
    withoutScope: findings.withoutScope,
    kevFloored: findings.kevFloored,
  };
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
