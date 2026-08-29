import { SCANNER_STATE_LABEL, type ScannerStatus } from './contracts.js';

// Per-scanner coverage (W8-10, NFR-15).
//
// This list is the honest half of the Security tab. Every other panel shows
// what WAS found; this one shows what was looked for — including the scanners
// that are off, the ones that have never run and the ones whose last run
// failed. A security screen without it can only ever say "no findings", which
// a reader will hear as "no problems".

interface Props {
  scanners: ScannerStatus[];
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Does this failure look like the scan image being absent (W16-11, F16)?
 *
 * Matched on the shapes the runtime actually produces — a container runtime
 * that is not on PATH (`spawn podman ENOENT`), and an image that has never
 * been built (`... image not known`, `manifest unknown`) — rather than on one
 * exact string, because the message comes from podman or docker and neither is
 * ours to pin.
 *
 * Deliberately a heuristic that only ADDS a line beneath the verbatim error.
 * Guessing wrong costs a reader one irrelevant sentence; not guessing at all
 * cost them the answer.
 */
export function looksLikeMissingScanTools(error: string): boolean {
  return (
    // The container runtime is absent, or the image has never been built.
    /enoent|not known|manifest unknown|no such image|podman|docker/i.test(error) ||
    // OBSERVED, not guessed. Running the demo against SCAN_IMAGE pointed at an
    // image that does not exist produced exactly two shapes on screen:
    // `exit 125` — podman's own code for "could not run the container" — and
    // `… produced no output`, from a tool that never started. The first
    // version of this heuristic matched neither, so the row that most needed
    // the build command was the one that did not get it.
    /\bexit 125\b/.test(error) ||
    /produced no output/i.test(error)
  );
}

/**
 * Does this failure look like a stale or missing VULNERABILITY database?
 *
 * A different answer from a missing image, and it needs a different command.
 * grype refuses a database older than five days and says so on stderr; the
 * scan tools image deliberately does not carry one, because baking a copy in
 * would ship a stale one that looks current.
 */
export function looksLikeStaleVulnDb(error: string): boolean {
  return /vulnerability database|vulnerability db|scan-db-sync/i.test(error);
}

export function ScannerStatusList({ scanners }: Props) {
  return (
    <table className="w-full text-sm" data-testid="scanner-status">
      <caption className="sr-only">Scanner coverage for this repository</caption>
      <thead>
        <tr className="text-left text-xs text-fg-muted">
          <th scope="col" className="py-1">
            Scanner
          </th>
          <th scope="col" className="py-1">
            State
          </th>
          <th scope="col" className="py-1">
            Last run
          </th>
          <th scope="col" className="py-1 text-right">
            Open
          </th>
        </tr>
      </thead>
      <tbody>
        {scanners.map((scanner) => (
          <tr
            key={scanner.key}
            className="border-t border-border"
            data-testid={`scanner-row-${scanner.key}`}
            data-state={scanner.state}
          >
            <th scope="row" className="py-1.5 text-left font-normal">
              {scanner.display_name}
              {scanner.scanner_version && (
                <span className="ml-2 text-xs text-fg-muted">{scanner.scanner_version}</span>
              )}
              {!scanner.registered && (
                // NOT "(not installed)" (W16-11, F16).
                //
                // That read as a missing TOOL — something you could go and
                // install — and for these rows it never was: a scanner is
                // unregistered when this build has no code for it, and no
                // amount of installing changes that. It also said nothing
                // about what to do, which is the half of F16 that mattered.
                //
                // Since W16-28 registered the catalogue, the only rows that
                // reach here are scanners genuinely absent from the build.
                <span className="ml-2 text-xs text-fg-muted" title="No code for this scanner ships in this build. It is documented so its absence is visible rather than looking deliberate.">
                  (not in this build)
                </span>
              )}
            </th>
            <td className="py-1.5">
              {/* Word + glyph, never colour alone (UX_SPEC §7). */}
              <span data-testid={`scanner-state-${scanner.key}`}>
                {SCANNER_STATE_LABEL[scanner.state]}
              </span>
              {scanner.state === 'all_rejected' && (
                // HOW MANY, not just that it happened (W16-38). A reader
                // deciding whether the prompt is wrong needs the number.
                <div className="text-xs text-fg-muted" data-testid={`scanner-rejected-${scanner.key}`}>
                  The model proposed {scanner.validation_funnel?.proposed ?? 0} finding
                  {(scanner.validation_funnel?.proposed ?? 0) === 1 ? '' : 's'} and the evidence
                  check rejected every one — their quotes were not verbatim from the diff. That is
                  a problem with the prompt or the check, not a clean repository.
                </div>
              )}
              {scanner.error && (
                <div className="text-xs text-fg-muted" data-testid={`scanner-error-${scanner.key}`}>
                  {scanner.error}
                  {looksLikeStaleVulnDb(scanner.error) && (
                    // A DIFFERENT command from the image one. grype refuses a
                    // database older than five days, and the image cannot
                    // carry one — a baked-in copy would ship stale and look
                    // current.
                    <div className="mt-0.5" data-testid={`scanner-db-${scanner.key}`}>
                      The vulnerability database is refreshed daily and is not part of the image.
                      Run{' '}
                      <code className="rounded bg-surface-2 px-1 font-mono">
                        deploy/scan-db-sync.sh
                      </code>{' '}
                      — see docs/RUNNING.md → Scan tools.
                    </div>
                  )}
                  {!looksLikeStaleVulnDb(scanner.error) && looksLikeMissingScanTools(scanner.error) && (
                    // WHAT TO DO ABOUT IT (W16-11, F16). A screen that says a
                    // tool is missing and stops there has told someone their
                    // scan failed and left them to guess.
                    <div className="mt-0.5" data-testid={`scanner-fix-${scanner.key}`}>
                      The scan tools run in a container image. Build it with{' '}
                      <code className="rounded bg-surface-2 px-1 font-mono">
                        podman build -f Containerfile.scan -t localhost/repopulse/scan:dev .
                      </code>{' '}
                      — see docs/RUNNING.md → Scan tools.
                    </div>
                  )}
                </div>
              )}
            </td>
            <td className="py-1.5">{when(scanner.last_run_at)}</td>
            <td className="py-1.5 text-right tabular-nums">
              {/* A dash, not 0, when nothing has looked: a zero here is a
                  claim, and an unrun scanner has not earned it. */}
              {scanner.state === 'not_enabled' ||
              scanner.state === 'never_run' ||
              scanner.state === 'nothing_scanned' ||
              // A zero here would be the same claim the label just refused.
              scanner.state === 'all_rejected' ||
              // A count from a scan still in flight is not its count, and one
              // from a scan that never finished is not a count at all.
              scanner.state === 'running' ||
              scanner.state === 'stale'
                ? '—'
                : scanner.open_findings}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
