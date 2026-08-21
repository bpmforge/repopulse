import type { ValidatedVulnerability } from '../validation/index.js';
import { basePurl, versionInRange } from './range.js';
import {
  suppresses,
  type ObservedVulnerability,
  type VexStatementRecord,
  type VexVerdict,
} from './types.js';

// Applying stored VEX statements to a scan's output (W8-14, FR-SEC-14).
//
// `under_investigation` IS COMPUTED, NOT STORED. Nothing writes a row to say a
// finding is untriaged — the absence of a covering statement means exactly
// that, and it means it for free, forever, for every finding the scanner has
// ever produced. Storing it instead would need a row per finding per scan and
// a reconciliation job to delete the ones that stopped applying, and the day
// that job lagged, a triaged finding and an untriaged one would disagree about
// which they were.
//
// That choice collapses BOTH of FR-SEC-14's acceptance criteria into one pure
// lookup. "A re-scan at a covered version creates zero new rows" and "a version
// outside the range reopens as under_investigation" are the two branches of
// `coveringStatement` — one function, one fixture set, no scan-time state.

/**
 * The statement that governs an observation, or null.
 *
 * MATCHES ON ALIASES TOO, which is not an optimisation. V0 merges a CVE and its
 * GHSA twin into one finding whose primary id depends on which provider grype
 * happened to report first, so a statement written against `GHSA-x` when the
 * finding was keyed `GHSA-x` would stop applying the day the database started
 * leading with `CVE-y`. The suppression would silently lapse and the finding
 * would reappear with its triage detached — the alias union is what stops that.
 */
export function coveringStatement(
  statements: readonly VexStatementRecord[],
  observed: ObservedVulnerability,
): VexVerdict {
  const pkg = basePurl(observed.purl);
  const ids = new Set([observed.vulnId, ...observed.aliases]);

  const forThisVulnerability = statements.filter(
    (statement) => basePurl(statement.packagePurl) === pkg && ids.has(statement.vulnId),
  );

  if (forThisVulnerability.length === 0) {
    return {
      status: 'under_investigation',
      statement: null,
      suppressed: false,
      reopened: false,
      reason: 'No VEX statement has been recorded for this package and vulnerability.',
    };
  }

  // NEWEST WINS among the statements that cover this version. Triage is a
  // record of what someone believed when they looked, and the most recent look
  // is the current answer; ordering by anything else would let a superseded
  // dismissal outrank the correction that replaced it.
  const covering = [...forThisVulnerability]
    .filter((statement) => versionInRange(observed.version, statement.versionRange).covered)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const winner = covering[0];
  if (winner) {
    const verdict = versionInRange(observed.version, winner.versionRange);
    return {
      status: winner.status,
      statement: winner,
      suppressed: suppresses(winner.status),
      reopened: false,
      reason:
        `${winner.author} recorded ${winner.status}` +
        `${winner.justification ? ` (${winner.justification})` : ''} for ${winner.versionRange}; ${verdict.reason}.`,
    };
  }

  // A statement exists, and this version is outside every range it covers.
  // THE SUPPRESSION DOES NOT CARRY OVER. Whatever the author checked, they
  // checked it against other code; an upgrade can introduce the call path the
  // old version never had, and inheriting the dismissal would mean the tool
  // stayed quiet about a vulnerability nobody had looked at in the version that
  // actually ships.
  const nearest = [...forThisVulnerability].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0]!;
  const why = versionInRange(observed.version, nearest.versionRange);
  return {
    status: 'under_investigation',
    statement: nearest,
    suppressed: false,
    reopened: true,
    reason:
      `Reopened: ${nearest.author} recorded ${nearest.status} for ${nearest.versionRange}, but ` +
      `${why.reason}. The evidence behind that decision does not describe the version installed now.`,
  };
}

/** An observation, from whatever a caller happens to be holding. */
export function observationOf(vulnerability: ValidatedVulnerability): ObservedVulnerability {
  return {
    vulnId: vulnerability.primaryId,
    aliases: vulnerability.aliases,
    // A vulnerability with no purl still has to be matchable, and the name is
    // the only identity left. `pkg:generic/<name>` keeps it in purl shape so
    // basePurl and the exports do not need a second code path for it.
    purl: vulnerability.purl ?? `pkg:generic/${vulnerability.packageName}`,
    version: vulnerability.packageVersion,
    packageName: vulnerability.packageName,
  };
}

export interface TriagedVulnerability {
  vulnerability: ValidatedVulnerability;
  observed: ObservedVulnerability;
  verdict: VexVerdict;
}

export interface VexApplication {
  /**
   * The vulnerabilities that still become findings.
   *
   * Everything a statement suppresses is absent from this list, which is how
   * "a re-scan at a covered version creates zero new rows" happens: the rows
   * are never offered to persistFindings in the first place. It is not a
   * delete and not an update — a suppressed finding simply never reaches the
   * store, so no triage state exists to be lost when the suppression is later
   * withdrawn.
   */
  reportable: TriagedVulnerability[];
  /** Suppressed by a covering not_affected or fixed statement. */
  suppressed: TriagedVulnerability[];
  /** Reopened because the installed version left the statement's range. */
  reopened: TriagedVulnerability[];
  /** Everything, in input order, for the funnel and the exports. */
  all: TriagedVulnerability[];
}

/**
 * Splits a scan's vulnerabilities by what VEX says about each.
 *
 * PURE, and deliberately so: the scan-time wiring is one call between
 * `validateVulnerabilities` and `dependencyFindings` in the dependency runner,
 * and keeping the decision out of the runner is what lets both acceptance
 * fixtures run without a container, a database or a network.
 */
export function applyVexStatements(
  vulnerabilities: readonly ValidatedVulnerability[],
  statements: readonly VexStatementRecord[],
): VexApplication {
  const all = vulnerabilities.map((vulnerability) => {
    const observed = observationOf(vulnerability);
    return { vulnerability, observed, verdict: coveringStatement(statements, observed) };
  });

  return {
    all,
    reportable: all.filter((entry) => !entry.verdict.suppressed),
    suppressed: all.filter((entry) => entry.verdict.suppressed),
    reopened: all.filter((entry) => entry.verdict.reopened),
  };
}
