import {
  VEX_JUSTIFICATION_LABEL,
  type ScannerStatus,
  type ValidationFunnel,
  type VexJustification,
  type VexSummary,
} from './contracts.js';

// The dependency honesty funnel (W8-14, SECURITY_SUITE.md §3.6, FR-SEC-15).
//
// "47 raw advisories → 9 still open" is the credibility story, and it only
// works if BOTH numbers are on the screen. A tool that shows nine has to be
// taken on faith; a tool that shows both is showing its work, and a reader who
// disagrees with the filtering can go and look at it.
//
// ── WHY THE BUCKETS ARE NOT FOUR EQUAL SIBLINGS ──────────────────────────────
//
// The obvious rendering — affected / not_affected / fixed / under_investigation
// as four counts under "of those N" — DOES NOT RECONCILE, and the first draft
// of this panel shipped it. Two of those four remove a finding and two do not:
// suppression works by never filing the row, so `not_affected` and `fixed`
// leave the open list while `affected` is a LABEL ON a row that is still open.
// Printing all four against the deduped total double-counts every confirmed
// vulnerability — 3 dismissed + 1 confirmed + 28 open against 31 deduped adds
// to 32, under a heading claiming it adds to 31.
//
// So the ladder narrows by the only thing that actually narrows (suppression),
// `affected` is shown as an annotation on the open count, and where the
// arithmetic still does not close — stale statements, or statements newer than
// the last scan — the panel SAYS SO rather than presenting a total that does
// not add up.

interface Props {
  funnel: ValidationFunnel | null;
  recorded: boolean;
  vex: VexSummary;
  /**
   * The scanner rows from the same payload.
   *
   * Passed whole rather than pre-reduced to a number so that the derivation
   * this panel reconciles against is the one the tests exercise. A caller that
   * computed the open count itself would leave the arithmetic below untested in
   * the only place it can be wrong.
   */
  scanners: ScannerStatus[];
}

/** Vulnerabilities V1 placed in a resolved dependency set. */
export function scopedCount(funnel: ValidationFunnel): number {
  return funnel.deduped - (funnel.scoped.notInResolvedSet + funnel.scoped.unreadable);
}

/**
 * Open dependency findings — the population VEX did NOT remove.
 *
 * A dash-worthy distinction the scanner-state rules already make: a scanner
 * that never ran has no open count, and treating its absence as 0 would report
 * a repository nobody scanned as fully triaged.
 */
export function openDependencyFindings(scanners: ScannerStatus[]): number | null {
  const row = scanners.find((scanner) => scanner.key === 'dependency_cve');
  if (!row || row.state === 'not_enabled' || row.state === 'never_run') return null;
  return row.open_findings;
}

export function ValidationFunnelPanel({ funnel, recorded, vex, scanners }: Props) {
  if (!recorded || !funnel) {
    // NOT A ROW OF ZEROES. `raw` lives only on the scan run that measured it,
    // so a repository whose last dependency scan predates the column has no
    // raw count anywhere — and printing 0 would say "no advisories" when it
    // means "nobody wrote the number down". Same rule as the scanner states.
    return (
      <p className="text-sm text-fg-muted" data-testid="funnel-unrecorded">
        No dependency scan has recorded a validation funnel for this repository yet, so the raw
        advisory count is unknown. It is not zero — it is unmeasured.
      </p>
    );
  }

  const suppressed = vex.not_affected + vex.fixed;
  const open = openDependencyFindings(scanners);
  const scoped = scopedCount(funnel);
  // Statements can outlive the scan they were written against, and a scan can
  // be older than the statements. Either way the two counts stop closing, and
  // the honest move is to name the gap rather than to print a total that does
  // not add up.
  const reconciles = open !== null && funnel.deduped - suppressed === open;

  return (
    <div className="flex flex-col gap-4" data-testid="validation-funnel">
      <ol className="flex flex-col gap-1 text-sm">
        <Step
          testId="funnel-raw"
          label="Raw advisories reported"
          value={funnel.raw}
          note="What the scanner said before anything was merged or classified."
        />
        <Step
          testId="funnel-deduped"
          label="Distinct vulnerabilities"
          value={funnel.deduped}
          note={
            funnel.raw === funnel.deduped
              ? 'Nothing was reported twice under two names.'
              : `${funnel.raw - funnel.deduped} were the same vulnerability under a second id ` +
                `(${funnel.withAliases} carry aliases).`
          }
        />
        <Step
          testId="funnel-scoped"
          label="Placed in a resolved dependency set"
          value={scoped}
          note={
            funnel.deduped - scoped === 0
              ? 'Every one was found in a lockfile this scan could read.'
              : `${funnel.deduped - scoped} were not — still reported and still priced, because ` +
                'an ecosystem we cannot read a manifest for is not an ecosystem without ' +
                'vulnerabilities.'
          }
        />
        <Step
          testId="funnel-suppressed"
          label="Suppressed by a VEX statement"
          value={suppressed}
          note={
            suppressed === 0
              ? 'Nothing has been dismissed. Every advisory above is still reported.'
              : `${vex.not_affected} judged not affected and ${vex.fixed} fixed — each with an ` +
                'author, a covered version range and the justification below.'
          }
        />
        <Step
          testId="funnel-open"
          label="Still open"
          value={open}
          note={
            open === null
              ? 'The dependency scanner has not run here, so there is no open count to show.'
              : `${vex.affected} of these carry a statement confirming the vulnerability is real; ` +
                `the remaining ${Math.max(0, open - vex.affected)} nobody has triaged.`
          }
        />
      </ol>

      {!reconciles && open !== null && (
        <p className="text-xs text-fg-muted" data-testid="funnel-does-not-reconcile">
          {/* Named, not smoothed over. The usual cause is a statement written
              after the last scan, or one covering a package the tree no longer
              has — both real, and both better read than hidden. */}
          These numbers do not close: {funnel.deduped} distinct minus {suppressed} suppressed is{' '}
          {funnel.deduped - suppressed}, not {open}. The statements and the last scan describe
          different moments — a re-scan reconciles them.
        </p>
      )}

      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
          Why each dismissal was made
        </h3>
        {vex.not_affected === 0 ? (
          <p className="mt-1 text-sm text-fg-muted" data-testid="vex-no-justifications">
            Nothing has been dismissed.
          </p>
        ) : (
          <dl className="mt-1 flex flex-col gap-1 text-sm" data-testid="vex-justifications">
            {(Object.keys(VEX_JUSTIFICATION_LABEL) as VexJustification[]).map((justification) => (
              // EVERY justification is listed, including the zeroes: an absent
              // row reads as a reason nobody is allowed to give, and the point
              // of a fixed enum is that a reader can see the whole menu the
              // triager chose from.
              <div
                key={justification}
                className="flex justify-between"
                data-testid={`vex-justification-${justification}`}
              >
                <dt>{VEX_JUSTIFICATION_LABEL[justification]}</dt>
                <dd className="tabular-nums">{vex.by_justification[justification] ?? 0}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {Object.keys(funnel.proposed).length > 0 && (
        <p className="text-xs text-fg-muted" data-testid="funnel-proposed">
          {/* PROPOSED, and labelled so. The validation tiers can suggest a
              dismissal; only a person can make one, and merging the two counts
              would let the scanner appear to have dismissed its own findings. */}
          The scan proposed {Object.values(funnel.proposed).reduce((a, b) => a + b, 0)} dismissals
          that nobody has confirmed. They are counted nowhere above.
        </p>
      )}
    </div>
  );
}

function Step({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: number | null;
  note: string;
  testId: string;
}) {
  return (
    <li className="flex flex-col" data-testid={testId}>
      <span className="flex justify-between">
        <span>{label}</span>
        {/* A dash, not 0, when nothing has looked — the rule the scanner table
            already follows. A zero here is a claim nobody has earned. */}
        <span className="tabular-nums">{value === null ? '—' : value}</span>
      </span>
      <span className="text-xs text-fg-muted">{note}</span>
    </li>
  );
}
