import { and, desc, eq } from 'drizzle-orm';
import { facts, type Database } from '@repopulse/shared';
import {
  DEFAULT_SCAN_IMAGE,
  SEMGREP_RULEPACK_DIR,
  SEMGREP_SCANNER_KEY,
  imageToolVersion,
  readRulepack,
  rulepackMountDir,
  type ScanProbe,
} from '@repopulse/security';

// Scan probes (W23-01): per scanner key, "what commit and which tool versions
// WOULD this run use?" — answered without doing the work, so the worker can skip
// an unchanged scan and POST /repos/:id/scan can say so before enqueueing.
//
// Shared by the worker entrypoint and the run route, which is why it lives here
// (inside the ticket's write scope) rather than in the entrypoint: the API
// process must not import `workers/index.ts`, which starts the workers.
//
// A MAP BY KEY, INJECTED. The framework (isUpToDate, runSweep) never branches
// on a scanner key; the one place a key is named is this table, the same shape
// as historyRunners/weeklyRunners.
//
// A scanner WITHOUT an entry here always runs. That is deliberate and the safe
// default: the tool versions of code_health_tools, dependency_cve, anti_slop and
// the architecture register are known only AFTER the run (they depend on which
// adapters the tree triggers, or on the SBOM the run builds), so no honest probe
// exists yet and a guessed one would skip a scan whose answer had changed.

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

const OPENGREP_VERSION_TTL_MS = 10 * 60_000;
let opengrepVersionCache: { image: string; value: string; at: number } | undefined;

/**
 * Opengrep's version, read from the scan image like the run does, but cached:
 * `imageToolVersion` starts a container, which is too heavy for every press of
 * a button. A stale entry can only make a probe DISAGREE with the next run's
 * stamp, i.e. cause a re-scan, never a wrong skip.
 */
function cachedOpengrepVersion(image: string, now: number): string {
  if (
    opengrepVersionCache &&
    opengrepVersionCache.image === image &&
    now - opengrepVersionCache.at < OPENGREP_VERSION_TTL_MS
  ) {
    return opengrepVersionCache.value;
  }
  const value = imageToolVersion(image);
  opengrepVersionCache = { image, value, at: now };
  return value;
}

/** Test seam. */
export function resetProbeCaches(): void {
  opengrepVersionCache = undefined;
}

/**
 * The tool_versions a default `runSemgrepFull` would stamp: engine + rulepack.
 * Null when it cannot be known honestly — the engine version is unreadable, or
 * the third-party pack is switched on (its version is not reachable from here,
 * and the run stamps it).
 */
export function semgrepExpectedToolVersions(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Record<string, string> | null {
  if (env['SCAN_THIRD_PARTY_RULES'] === 'on') return null;
  const opengrep = cachedOpengrepVersion(DEFAULT_SCAN_IMAGE, now);
  if (opengrep === 'unknown') return null;
  try {
    const rulepack = readRulepack(rulepackMountDir(SEMGREP_RULEPACK_DIR)).version;
    return { opengrep, rulepack };
  } catch {
    return null;
  }
}

export function buildScanProbes(db: Database): Record<string, ScanProbe> {
  return {
    [SEMGREP_SCANNER_KEY]: async ({ workspaceId, repoId }) => {
      const commitSha = await headShaFor(db, workspaceId, repoId);
      if (!commitSha) return null;
      const toolVersions = semgrepExpectedToolVersions();
      if (!toolVersions) return null;
      return { commitSha, toolVersions };
    },
  };
}
