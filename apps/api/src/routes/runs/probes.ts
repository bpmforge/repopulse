import { and, desc, eq } from 'drizzle-orm';
import { core, facts, security, type Database } from '@repopulse/shared';
import {
  ANTI_SLOP_SCANNER_KEY,
  ARCHITECTURE_ADAPTERS,
  ARCHITECTURE_SCANNER_KEY,
  CODE_HEALTH_SCANNER_KEY,
  DEFAULT_SCAN_IMAGE,
  DEPENDENCY_SCANNER_KEY,
  IMAGE_SCANNER_KEY,
  SEMGREP_SCANNER_KEY,
  SUPPLY_CHAIN_REGISTER_KEY,
  antiSlopDataVersion,
  codeHealthDataVersion,
  dataStamp,
  dependencyDataVersion,
  getScanner,
  imageDataVersion,
  latestBaseline,
  loadArchitecturePack,
  policyFrom,
  ruleStateStamp,
  semgrepDataVersion,
  shortHash,
  type ScanProbe,
  type ScanProbeResult,
} from '@repopulse/security';

// Scan probes (W23-01, W23-09): per scanner key, "what commit, tool versions and
// data WOULD this run use?" — answered without doing the work, so the worker can
// skip an unchanged scan and POST /repos/:id/scan can say so before enqueueing.
//
// Shared by the worker entrypoint and the run route, which is why it lives here
// (inside the ticket's write scope) rather than in the entrypoint: the API
// process must not import `workers/index.ts`, which starts the workers.
//
// A MAP BY KEY, INJECTED. The framework (isUpToDate, runSweep) never branches
// on a scanner key; the one place a key is named is this table, the same shape
// as historyRunners/weeklyRunners.
//
// HOW A PROBE KNOWS WHAT A RUN WOULD STAMP, WITHOUT RUNNING IT (W23-09)
//
//   commitSha     the newest ingested commit — the same head the runner pins to.
//   toolVersions  the `tool_versions` of the newest succeeded run at that commit.
//                 Every versioned thing the scanners stamp is a function of the
//                 TREE (which adapters triggered, which packages the SBOM held)
//                 and of the scan image / registry that `dataVersion` below
//                 pins, so for an unchanged commit those versions cannot differ
//                 from what the last run read. This is what lets a probe skip
//                 starting podman (the semgrep engine version) or reading the
//                 tree (the adapters the tree triggers). No such run -> null.
//   dataVersion   everything ELSE the answer stands on, recomputed from files and
//                 rows (rulepack, scan image, advisory database, rule lifecycle
//                 state, a registry day bucket) by the same function the runner
//                 stamps with (each one lives beside its runner in the security
//                 package; two copies would drift).
//
// A probe returns null — "cannot say, run it" — whenever an input that applies
// cannot be read, or no earlier run answered this commit (there is nothing to
// skip to). It never returns `dataVersion: null`: the framework reads that as
// "this scanner depends on no data", which would ignore the comparison.
//
// A scanner WITHOUT an entry always runs. Those are listed in ALWAYS_RUN with
// the reason, and a test fails when a worker runner is in neither list.

/**
 * Runners that deliberately have no probe, and why. Read by the test that keeps
 * this honest: every `weeklyRunners` key is in `PROBED_RUNNERS` or here.
 */
export const ALWAYS_RUN: Readonly<Record<string, string>> = {
  knowledge_register:
    'Pure SQL over commits already in the warehouse, no tarball and no tool: it costs nothing, and its input is a rolling 90-day window, so the same head answers differently as the window moves.',
  test_gap_register:
    'Pure SQL over commits already in the warehouse, no tarball and no tool: it costs nothing, and its churn distribution moves with the warehouse, not with a head SHA.',
  attack_chainer:
    'Reads the findings table, which every other scanner changes, and calls no forge: a recompute is cheap and a skip would leave chains built on findings that have since closed.',
  code_scanning_pull:
    'Its input IS live forge state (GitHub code-scanning alerts); no commit, tool version or data stamp says whether an alert was opened or dismissed since. It makes no tarball fetch.',
  owasp_web:
    'A model-judged checklist over the newest diff, started by a person (manual only). Which model answers is known only after it does (stamped in tool_versions), and a repeat press is a request for a fresh judgement; it makes no tarball fetch.',
  owasp_llm:
    'A model-judged checklist over the newest diff, started by a person (manual only). Which model answers is known only after it does (stamped in tool_versions), and a repeat press is a request for a fresh judgement; it makes no tarball fetch.',
  rule_draft_pass:
    'Workspace-scoped (not per repo) learning pass over 30 days of dismissals and verdicts through a model; there is no commit to compare and it makes no tarball fetch.',
};

/** Keys `buildScanProbes` can return a probe for (anti_slop only when a judgement source is injected). */
export const PROBED_RUNNERS: readonly string[] = [
  SEMGREP_SCANNER_KEY,
  CODE_HEALTH_SCANNER_KEY,
  DEPENDENCY_SCANNER_KEY,
  IMAGE_SCANNER_KEY,
  ANTI_SLOP_SCANNER_KEY,
  SUPPLY_CHAIN_REGISTER_KEY,
  ARCHITECTURE_SCANNER_KEY,
];

/**
 * The newest ingested commit for a repo — the same "head" the weekly runners
 * pin to (the only head SHA this side of the product knows). Workspace-filtered
 * (Law 5); the runners' own lookups filter on repo only, which is harmless
 * there because a repo id is unique and is tightened here for free.
 */
export async function headShaFor(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<string | null> {
  const [head] = await db
    .select({ sha: facts.commits.sha })
    .from(facts.commits)
    .where(and(eq(facts.commits.workspaceId, workspaceId), eq(facts.commits.repoId, repoId)))
    .orderBy(desc(facts.commits.committedAt))
    .limit(1);
  return head?.sha ?? null;
}

/**
 * The probe answer for a scanner whose runner pins to `commitSha` and whose
 * inputs are summarised by `dataVersion`: the cached versions of the newest
 * succeeded run at that commit, or null when there is none (or `dataVersion`
 * cannot be computed, or the cached versions are not usable).
 */
async function cachedProbe(
  db: Database,
  q: {
    workspaceId: number;
    repoId: number;
    scannerKey: string;
    commitSha: string;
    dataVersion: string | null;
    /** Reject cached versions that cannot honestly stand in (an `unknown` engine). */
    usable?: (toolVersions: Record<string, string> | null) => boolean;
  },
): Promise<ScanProbeResult | null> {
  if (q.dataVersion === null) return null;
  const baseline = await latestBaseline(db, q);
  if (!baseline) return null;
  if (q.usable && !q.usable(baseline.toolVersions)) return null;
  return {
    commitSha: q.commitSha,
    toolVersions: baseline.toolVersions,
    dataVersion: q.dataVersion,
  };
}

// ---- semgrep ---------------------------------------------------------------

/**
 * The engine version a semgrep probe stands on is the one the LAST run read from
 * the image (`opengrep --version`, stamped in its tool_versions) — no container
 * is started at probe time, so the packaged stack, where the API process has no
 * podman, can still answer. It is only reused while the data stamp (which names
 * the scan image) is unchanged, and never when that run could not read it.
 */
const engineKnown = (toolVersions: Record<string, string> | null): boolean => {
  const engine = toolVersions?.['opengrep'];
  return engine !== undefined && engine !== '' && engine !== 'unknown';
};

// ---- supply chain register -------------------------------------------------

/**
 * The newest SBOM — what the register reads, and the commit its run row carries
 * (not the repository head: the register's input is the SBOM, whose commit is
 * whichever the last dependency scan saw).
 */
async function latestSbom(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<{ id: number; commitSha: string } | null> {
  const [sbom] = await db
    .select({ id: security.sboms.id, commitSha: security.sboms.commitSha })
    .from(security.sboms)
    .where(and(eq(security.sboms.workspaceId, workspaceId), eq(security.sboms.repoId, repoId)))
    .orderBy(desc(security.sboms.createdAt))
    .limit(1);
  return sbom ?? null;
}

/**
 * The supply-chain register's data stamp, which the worker's runner stamps on its
 * row and its probe recomputes. Null when there is no SBOM (the runner reports
 * `no_sbom`) or the stamp cannot be built.
 *
 * What the register's answer stands on: the SBOM (identity, not just commit — a
 * re-scan of the same commit regenerates it), the head the EOL half snapshots
 * for Dockerfiles and manifests, the workspace's license policy, and the
 * REGISTRY DATA it refreshes itself from the network on every run (npm/PyPI
 * release metadata, endoflife.date). That data has no stamp to read before the
 * run, so it is bounded by time instead: a UTC day bucket, which is the cadence
 * the register already has (it is the nightly pass). A repeat press within the
 * day skips; the next day re-reads the registries. It does not read the grype
 * advisory database, so that is deliberately not part of this stamp.
 */
export async function supplyChainDataVersion(
  db: Database,
  workspaceId: number,
  repoId: number,
  now: Date = new Date(),
): Promise<{ commitSha: string; dataVersion: string } | null> {
  const sbom = await latestSbom(db, workspaceId, repoId);
  if (!sbom) return null;
  const [workspace] = await db
    .select({ settings: core.workspaces.settings })
    .from(core.workspaces)
    .where(eq(core.workspaces.id, workspaceId));
  const head = await headShaFor(db, workspaceId, repoId);
  const dataVersion = dataStamp({
    sbom: String(sbom.id),
    head: head ?? 'none',
    policy: shortHash(JSON.stringify(policyFrom(workspace?.settings ?? null))),
    registries: `day:${now.toISOString().slice(0, 10)}`,
    scanner: getScanner(SUPPLY_CHAIN_REGISTER_KEY)?.version,
  });
  return dataVersion === null ? null : { commitSha: sbom.commitSha, dataVersion };
}

// ---- architecture ----------------------------------------------------------

/**
 * The architecture register's data stamp. Which adapters a tree triggers is
 * known after the run (and is in `tool_versions`); what the probe can know
 * without the tree is everything that could change the answer for the SAME
 * tree: every registered adapter and its version (a new one may apply to it),
 * the drift pack's version, the scan image and the in-process scanner version.
 * Null when the pack cannot be read.
 */
export function architectureDataVersion(): string | null {
  try {
    return dataStamp({
      adapters: shortHash(
        ARCHITECTURE_ADAPTERS.map((a) => `${a.key}@${a.version}`)
          .sort()
          .join(','),
      ),
      pack: String(loadArchitecturePack().version),
      image: DEFAULT_SCAN_IMAGE,
      scanner: getScanner(ARCHITECTURE_SCANNER_KEY)?.version,
    });
  } catch {
    return null;
  }
}

// ---- anti-slop -------------------------------------------------------------

/**
 * The judgement state of an anti-slop run as a string: `off` (AI paused, or no
 * model configured: only the deterministic half runs) or `on:<hosts>` (a model
 * reviews the candidates, and WHICH model is part of the answer). Pure, so the
 * worker's runner and the probe describe the same gateway the same way.
 */
export function judgementStateOf(
  hosts: readonly { name?: string | undefined; baseUrl: string; modelSlot: string }[] | null,
): string {
  if (!hosts || hosts.length === 0) return 'off';
  return `on:${hosts
    .map((h) => `${h.name ?? h.baseUrl}/${h.modelSlot}`)
    .sort()
    .join(',')}`;
}

/** The stamp the worker's anti-slop runner records and its probe recomputes. */
export async function antiSlopRunDataVersion(
  db: Database,
  workspaceId: number,
  judgement: string,
): Promise<string | null> {
  return antiSlopDataVersion(judgement, await ruleStateStamp(db, workspaceId));
}

/** Stamps `data_version` on a run row a runner wrote without one (workspace-filtered, Law 5). */
export async function stampDataVersion(
  db: Database,
  workspaceId: number,
  scanRunId: number | null,
  dataVersion: string | null,
): Promise<void> {
  if (scanRunId === null || dataVersion === null) return;
  await db
    .update(security.scanRuns)
    .set({ dataVersion })
    .where(
      and(eq(security.scanRuns.id, scanRunId), eq(security.scanRuns.workspaceId, workspaceId)),
    );
}

export interface ProbeOptions {
  /**
   * Describes the workspace's anti-slop judgement state (`judgementStateOf`).
   * Only the worker can build a gateway, so the API route passes nothing and
   * the anti-slop probe then says "cannot say" there; the worker still skips.
   */
  antiSlopJudgement?: (workspaceId: number) => Promise<string>;
}

export function buildScanProbes(db: Database, opts: ProbeOptions = {}): Record<string, ScanProbe> {
  /** A probe for a runner that pins to the repository head. */
  const atHead =
    (
      scannerKey: string,
      dataVersion: (workspaceId: number) => Promise<string | null> | string | null,
      usable?: (toolVersions: Record<string, string> | null) => boolean,
    ): ScanProbe =>
    async ({ workspaceId, repoId }) => {
      const commitSha = await headShaFor(db, workspaceId, repoId);
      if (!commitSha) return null;
      return cachedProbe(db, {
        workspaceId,
        repoId,
        scannerKey,
        commitSha,
        dataVersion: await dataVersion(workspaceId),
        ...(usable ? { usable } : {}),
      });
    };

  const probes: Record<string, ScanProbe> = {
    [SEMGREP_SCANNER_KEY]: atHead(
      SEMGREP_SCANNER_KEY,
      async (workspaceId) =>
        semgrepDataVersion(undefined, undefined, await ruleStateStamp(db, workspaceId)),
      engineKnown,
    ),
    [CODE_HEALTH_SCANNER_KEY]: atHead(CODE_HEALTH_SCANNER_KEY, async (workspaceId) =>
      codeHealthDataVersion(undefined, await ruleStateStamp(db, workspaceId)),
    ),
    [DEPENDENCY_SCANNER_KEY]: atHead(DEPENDENCY_SCANNER_KEY, () => dependencyDataVersion()),
    [IMAGE_SCANNER_KEY]: atHead(IMAGE_SCANNER_KEY, () => imageDataVersion()),
    [ARCHITECTURE_SCANNER_KEY]: atHead(ARCHITECTURE_SCANNER_KEY, () => architectureDataVersion()),
    [SUPPLY_CHAIN_REGISTER_KEY]: async ({ workspaceId, repoId }) => {
      const stamp = await supplyChainDataVersion(db, workspaceId, repoId);
      if (!stamp) return null;
      return cachedProbe(db, {
        workspaceId,
        repoId,
        scannerKey: SUPPLY_CHAIN_REGISTER_KEY,
        commitSha: stamp.commitSha,
        dataVersion: stamp.dataVersion,
      });
    },
  };

  const judgement = opts.antiSlopJudgement;
  if (judgement) {
    probes[ANTI_SLOP_SCANNER_KEY] = atHead(ANTI_SLOP_SCANNER_KEY, async (workspaceId) =>
      antiSlopRunDataVersion(db, workspaceId, await judgement(workspaceId)),
    );
  }
  return probes;
}
