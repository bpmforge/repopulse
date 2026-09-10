// Coverage state for an empty top-actions card (W17-16).
//
// PURE, over the capability rows the caller read from the ONE canonical
// producer (W17-10). Nothing here re-derives freshness — a second parallel
// status system is precisely what that ticket exists to prevent.
//
// The reason this exists at all: an empty list of actions has two completely
// different meanings, and the card renders the same in both. "We measured your
// nine repositories and there is nothing pressing" and "we have never
// successfully measured anything" must not produce the same sentence, because
// the second one dressed as the first is the product telling a team their code
// is fine when it has not looked at it.

/** The subset of a W17-10 capability row this summary needs. */
export interface CoverageCapabilityInput {
  id: string;
  kind: string;
  state: string;
  lastSuccessAt: string | null;
  stale: boolean;
  detail?: string;
}

export interface RepoCoverageInput {
  repoId: number;
  repoName: string;
  capabilities: readonly CoverageCapabilityInput[];
}

/**
 * An operational notice: something is not running, or ran and failed.
 *
 * NOT a finding. An ingestion or scan failure says nothing about the code — it
 * says something about us. Filing it as a code vulnerability would put an
 * outage in the security register and inflate the very numbers this product
 * asks people to trust.
 */
export interface CoverageNotice {
  repoId: number;
  repoName: string;
  capability: string;
  state: string;
  detail: string;
}

export interface CoverageState {
  /** `none` nothing has ever succeeded · `partial` some gap · `full` all measured and fresh. */
  basis: 'none' | 'partial' | 'full';
  reposTotal: number;
  reposMeasured: number;
  reposNeverMeasured: number;
  reposStale: number;
  /** Operational notices, deterministic order. Capped by the caller's repo set. */
  notices: CoverageNotice[];
  /** Capability ids that are reserved but not shipped in this release. */
  unsupported: string[];
  /** One sentence for the card. Never a clean bill of health on its own. */
  summary: string;
}

/** A repository counts as measured when ANY capability has ever succeeded. */
function isMeasured(repo: RepoCoverageInput): boolean {
  return repo.capabilities.some((c) => c.lastSuccessAt !== null);
}

function noticesFor(repo: RepoCoverageInput): CoverageNotice[] {
  const out: CoverageNotice[] = [];
  for (const capability of repo.capabilities) {
    // `failed` is the operational case. `not_configured` for AI review is the
    // other one worth saying out loud, because a workspace with no model is a
    // workspace where a whole tier never ran — and that is a setup fact, not a
    // quiet absence of findings.
    const isNotice =
      capability.state === 'failed' ||
      (capability.state === 'not_configured' && capability.kind === 'ai_review');
    if (!isNotice) continue;
    out.push({
      repoId: repo.repoId,
      repoName: repo.repoName,
      capability: capability.id,
      state: capability.state,
      detail: capability.detail ?? '',
    });
  }
  return out;
}

/**
 * Summarize what has and has not been measured across a bounded repo set.
 *
 * `repos` is whatever the caller decided to read — this function reports
 * `reposTotal` from it and never implies it covered more than it was given.
 */
export function summarizeCoverage(repos: readonly RepoCoverageInput[]): CoverageState {
  const reposTotal = repos.length;
  const measured = repos.filter(isMeasured);
  const reposMeasured = measured.length;
  const reposNeverMeasured = reposTotal - reposMeasured;
  const reposStale = repos.filter((r) => r.capabilities.some((c) => c.stale)).length;

  const notices = repos
    .flatMap(noticesFor)
    // Sorted so two reads of the same warehouse produce the same card. Ends on
    // the repo id, which is unique, so two repositories sharing a name still
    // have a settled order.
    .sort(
      (a, b) =>
        a.repoName.localeCompare(b.repoName) ||
        a.repoId - b.repoId ||
        a.capability.localeCompare(b.capability),
    );

  const unsupported = [
    ...new Set(
      repos.flatMap((r) =>
        r.capabilities.filter((c) => c.state === 'not_supported').map((c) => c.id),
      ),
    ),
  ].sort();

  const basis: CoverageState['basis'] =
    reposMeasured === 0
      ? 'none'
      : reposNeverMeasured === 0 && reposStale === 0 && notices.length === 0
        ? 'full'
        : 'partial';

  return {
    basis,
    reposTotal,
    reposMeasured,
    reposNeverMeasured,
    reposStale,
    notices,
    unsupported,
    summary: summaryFor({ basis, reposTotal, reposMeasured, reposStale, notices, unsupported }),
  };
}

function summaryFor(state: {
  basis: CoverageState['basis'];
  reposTotal: number;
  reposMeasured: number;
  reposStale: number;
  notices: readonly CoverageNotice[];
  unsupported: readonly string[];
}): string {
  if (state.reposTotal === 0) {
    return 'No repositories are connected yet, so nothing has been measured.';
  }
  if (state.basis === 'none') {
    return `Nothing has been measured yet across ${state.reposTotal} ${plural(state.reposTotal, 'repository', 'repositories')} — this is not a clean result, it is an absence of one.`;
  }

  const clauses = [
    `${state.reposMeasured} of ${state.reposTotal} ${plural(state.reposTotal, 'repository has', 'repositories have')} been measured`,
  ];
  if (state.reposStale > 0) {
    clauses.push(
      `${state.reposStale} ${plural(state.reposStale, 'has', 'have')} not been measured recently`,
    );
  }
  if (state.notices.length > 0) {
    clauses.push(
      `${state.notices.length} ${plural(state.notices.length, 'capability is', 'capabilities are')} failing or not configured`,
    );
  }
  if (state.unsupported.length > 0) {
    clauses.push(
      `${state.unsupported.join(' and ')} ${plural(state.unsupported.length, 'is', 'are')} not available in this release`,
    );
  }
  // Deliberately never "everything is fine": the sentence states what WAS
  // measured, so the reader can judge the silence for themselves.
  return `No actions right now. ${joinClauses(clauses)}.`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length === 1) return capitalize(clauses[0] as string);
  return capitalize(
    `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1] as string}`,
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
