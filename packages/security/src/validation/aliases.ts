import type { DependencyMatch } from '../scanners/dependency/matches.js';

// V0 — alias dedup (W8-13, SECURITY_SUITE.md §3.6, FR-SEC-13).
//
// One vulnerability arrives more than once. grype carries a github advisory
// and an nvd record for the same flaw, and reports each as its own match:
// `GHSA-8q59-q68h-6hv4` and `CVE-2020-14343` against pyyaml 5.3.1 are the same
// sentence said twice (captured — fixtures/dependency/python). Two rows for
// one problem is how a triage list becomes twice as long as the work in it.
//
// WHAT THIS ADDS OVER WHAT W8-06 ALREADY DOES. parseGrypeMatches collapses on
// (purl, CVE), which handles the common pair — both records resolve to the
// same CVE. It does NOT handle the pair whose link is an alias rather than a
// shared CVE: a GHSA-only advisory (no relatedVulnerabilities, so no CVE to
// key on) alongside an nvd record for the same flaw keys as two rows there and
// as ONE here. This tier keys on the ALIAS SET, so the (purl, CVE) key becomes
// a special case of it rather than a separate rule, and — the part W8-06 could
// not do at all — the merged row REMEMBERS both ids.

export interface AliasGroup {
  /** The merged match: worst severity, KEV if either said KEV, best evidence. */
  match: DependencyMatch;
  /** Preferred id — the CVE when the set has one, else grype's own id. */
  primaryId: string;
  /** Every OTHER id in the set, sorted. Empty when the vuln has just one. */
  aliases: string[];
}

export interface AliasDedupResult {
  groups: AliasGroup[];
  /** Matches merged away. `matches.length - groups.length`, stated. */
  collapsed: number;
}

const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;

/** The package a vulnerability is reported against — the merge is per package. */
function componentKey(match: DependencyMatch): string {
  return match.purl ?? `${match.packageType}\0${match.packageName}\0${match.packageVersion}`;
}

/**
 * Groups matches whose id sets overlap, per package.
 *
 * Union-find rather than a single pass, because aliasing is TRANSITIVE and
 * arrives in pieces: a record naming {GHSA-a, CVE-x} and a record naming
 * {CVE-x, GHSA-b} put GHSA-a and GHSA-b in one group without any record ever
 * naming both. A pass that only compared adjacent pairs would leave two rows.
 *
 * Grouping is scoped to ONE PACKAGE. The same CVE against two different
 * packages is two findings — two things to upgrade — and merging on the
 * vulnerability alone would hide one of them behind the other.
 */
export function dedupeByAlias(matches: readonly DependencyMatch[]): AliasDedupResult {
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so a long alias chain does not make this quadratic.
    let walk = i;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };

  // (component, id) -> the first match index that named it.
  const seen = new Map<string, number>();
  matches.forEach((match, index) => {
    parent.set(index, index);
    const component = componentKey(match);
    // `ids` is the union of the four places an id can appear; falling back to
    // the primary id keeps a match with an unreadable vulnerability block in
    // its own group rather than merging it into whichever group is first.
    const ids = match.ids.length > 0 ? match.ids : [match.vulnerabilityId];
    for (const id of ids) {
      // Upper-cased for COMPARISON only: providers disagree about the case of a
      // GHSA id, and two spellings of one id must not become two findings. The
      // id itself is stored as it was published.
      const key = `${component}\0${id.toUpperCase()}`;
      const prior = seen.get(key);
      if (prior === undefined) seen.set(key, index);
      else union(prior, index);
    }
  });

  const byRoot = new Map<number, number[]>();
  matches.forEach((_, index) => {
    const root = find(index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), index]);
  });

  const groups: AliasGroup[] = [];
  for (const members of byRoot.values()) {
    const merged = mergeMatches(members.map((index) => matches[index]!));
    const ids = merged.ids.length > 0 ? merged.ids : [merged.vulnerabilityId];
    // The CVE is preferred as the primary id because it is the id an advisory
    // email, a compliance spreadsheet and a customer question all arrive with.
    // The GHSA is kept as an alias rather than dropped, for the same reason.
    const primaryId = ids.find((id) => CVE_ID.test(id)) ?? merged.vulnerabilityId;
    groups.push({
      match: merged,
      primaryId,
      aliases: ids.filter((id) => id !== primaryId),
    });
  }

  // Sorted so the funnel, the findings and the tests do not depend on the order
  // grype happened to walk its database.
  groups.sort((a, b) =>
    a.match.packageName === b.match.packageName
      ? a.primaryId.localeCompare(b.primaryId)
      : a.match.packageName.localeCompare(b.match.packageName),
  );

  return { groups, collapsed: matches.length - groups.length };
}

/**
 * One match out of several reports of one vulnerability.
 *
 * Every field takes the WORST or the UNION, never the first: two providers
 * disagreeing about severity is ordinary, and picking whichever arrived first
 * would make a critical finding medium on a day the database was walked in a
 * different order.
 */
function mergeMatches(members: readonly DependencyMatch[]): DependencyMatch {
  const worst = members.reduce((best, match) =>
    match.severity > best.severity || (match.kev && !best.kev) ? match : best,
  );
  const epssScores = members
    .map((match) => match.epss)
    .filter((score): score is number => score !== null);

  return {
    ...worst,
    ids: [...new Set(members.flatMap((match) => match.ids))].sort(),
    // A CVE from ANY member: one provider knowing the CVE is enough to know it,
    // and the winner on severity is not necessarily the one that carried it.
    cveId: worst.cveId ?? members.find((match) => match.cveId !== null)?.cveId ?? null,
    kev: members.some((match) => match.kev),
    epss: epssScores.length > 0 ? Math.max(...epssScores) : null,
    // Fixes and locations UNION: one provider naming a fixed version the other
    // did not know about is the useful direction, and both lists are short.
    fixVersions: [...new Set(members.flatMap((match) => match.fixVersions))],
    locations: [...new Set(members.flatMap((match) => match.locations))],
    // An exact match anywhere in the group beats a cpe guess, EVEN WHEN IT COMES
    // FROM A DIFFERENT RECORD THAN THE SEVERITY DID. The merged row is
    // deliberately a composite of the strongest true claim on each axis: one
    // provider saying "critical" and another saying "this is exactly that
    // package" are both true of the same vulnerability, and downgrading either
    // to keep the row single-sourced would understate what is known between
    // them. Confidence follows this in findings.ts, so taking the worst here
    // would file a version-range match on an exact package identity at 3.
    matchType:
      members.find((match) => match.matchType.startsWith('exact-'))?.matchType ?? worst.matchType,
  };
}
