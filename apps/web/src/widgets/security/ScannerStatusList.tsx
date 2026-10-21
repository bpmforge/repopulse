import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery } from '../../api/useApiQuery.js';
import {
  hasMeasuredCount,
  scannerStateLabel,
  type ScannerState,
  type ScannerStatus,
  type SecurityTooling,
} from './contracts.js';

// Per-scanner coverage (W8-10, NFR-15).
//
// This list is the honest half of the Security tab. Every other panel shows
// what WAS found; this one shows what was looked for — including the scanners
// that are off, the ones that have never run and the ones whose last run
// failed. A security screen without it can only ever say "no findings", which
// a reader will hear as "no problems".

interface Props {
  scanners: ScannerStatus[];
  /**
   * W20-08 (UX_TODO FND-07): with a repository and an admin, each row gets an
   * on/off switch (PUT /scanners/:key). Absent = the read-only table.
   */
  manage?: { repoId: string; invalidate: readonly (readonly unknown[])[] } | null;
}

/**
 * What turning a scanner on costs and sends, beyond its default's rationale
 * (W20-08, UX_TODO FND-07). Named for the scanners whose cost is not "one more
 * pass over a snapshot we already have".
 */
export const SCANNER_COST: Record<string, string> = {
  container_image:
    'Pulls each image the repository names from its registry (network traffic to that registry) and scans it in the sandbox; slow on large images.',
  owasp_llm:
    'Sends changed code to the analysis model this workspace routes to, so model calls and any egress the routing allows apply.',
  owasp_web:
    'Sends changed code to the analysis model this workspace routes to, so model calls and any egress the routing allows apply.',
};

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
 * The part of an error the scan container itself produced (W20-21, UX_TODO
 * FND-62). The image scanner's run error also lists registry pull failures
 * ("Could not pull …: manifest unknown") and images over the per-run limit,
 * and those matched the missing-tools heuristic ("docker", "manifest
 * unknown") although the scan tools were fine. Other scanners' errors are
 * returned whole.
 */
export function sandboxPartOf(error: string): string {
  return error
    .split('; ')
    .filter((part) => !/^(Could not pull |Not scanned \(over the )/.test(part))
    .join('; ');
}

/** Whether the error names an image the registry would not hand over. */
export function hasPullFailure(error: string): boolean {
  return error.split('; ').some((part) => part.startsWith('Could not pull '));
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

/**
 * Problem states first (W20-13, UX_TODO FND-31). Alphabetical, 18 rows buried
 * a failed or switched-off scanner among "enabled, has never run". Within a
 * state the order stays alphabetical.
 */
const STATE_ORDER: Record<ScannerState, number> = {
  error: 0,
  stale: 1,
  partial: 2,
  all_rejected: 3,
  nothing_scanned: 4,
  running: 5,
  never_run: 6,
  not_enabled: 7,
  ok: 8,
};

export function sortScanners(scanners: readonly ScannerStatus[]): ScannerStatus[] {
  return [...scanners].sort(
    (a, b) =>
      (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
      a.display_name.localeCompare(b.display_name),
  );
}

/** States where re-running one scanner on its own is the next step (FND-30). */
const RERUN_STATES: readonly ScannerState[] = [
  'error',
  'stale',
  'partial',
  'never_run',
  'nothing_scanned',
];

export function ScannerStatusList({ scanners, manage = null }: Props) {
  const problems = scanners.filter((s) => (STATE_ORDER[s.state] ?? 9) <= 4).length;
  return (
    <table className="table-plain w-full text-sm" data-testid="scanner-status">
      <caption
        className="pb-1 text-left text-xs text-fg-muted"
        data-testid="scanner-status-caption"
      >
        {problems > 0
          ? `${problems} of ${scanners.length} scanners need attention; they are listed first.`
          : `${scanners.length} scanners.`}
      </caption>
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
          <th scope="col" className="py-1">
            Runs
          </th>
          <th scope="col" className="py-1 text-right">
            Open
          </th>
          {manage && (
            <th scope="col" className="py-1 text-right">
              On for this repository
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {sortScanners(scanners).map((scanner) => (
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
                <span
                  className="ml-2 text-xs text-fg-muted"
                  title="No code for this scanner ships in this build. It is documented so its absence is visible rather than looking deliberate."
                >
                  (not in this build)
                </span>
              )}
            </th>
            <td className="py-1.5">
              {/* Word + glyph, never colour alone (UX_SPEC §7). */}
              <span data-testid={`scanner-state-${scanner.key}`}>
                {scannerStateLabel(scanner.state, scanner.open_findings)}
              </span>
              {scanner.state === 'all_rejected' && (
                // HOW MANY, not just that it happened (W16-38). A reader
                // deciding whether the prompt is wrong needs the number.
                <div
                  className="text-xs text-fg-muted"
                  data-testid={`scanner-rejected-${scanner.key}`}
                >
                  The model proposed {scanner.validation_funnel?.proposed ?? 0} finding
                  {(scanner.validation_funnel?.proposed ?? 0) === 1 ? '' : 's'} and the evidence
                  check rejected every one — their quotes were not verbatim from the diff. That is a
                  problem with the prompt or the check, not a clean repository.
                </div>
              )}
              {scanner.error && (
                <ScannerErrorDetail scannerKey={scanner.key} error={scanner.error} />
              )}
              {manage &&
                scanner.registered &&
                scanner.enabled &&
                RERUN_STATES.includes(scanner.state) && (
                  <RerunScanner scanner={scanner} manage={manage} />
                )}
            </td>
            <td className="py-1.5">{when(scanner.last_run_at)}</td>
            {/* W20-21 (FND-52): when it runs without anyone pressing Run. */}
            <td
              className="py-1.5 text-xs text-fg-muted"
              data-testid={`scanner-runs-${scanner.key}`}
              title={scanner.runs?.cron ? `Schedule: ${scanner.runs.cron}` : undefined}
            >
              {scanner.runs?.text ?? '—'}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {/* A dash, not 0, when nothing has looked: a zero here is a
                  claim, and an unrun scanner has not earned it. Nor from a
                  scan still in flight, one that never finished, one that
                  scanned nothing, or one whose every finding was rejected —
                  the count column must not make the claim the label refused. */}
              {hasMeasuredCount(scanner.state) ? scanner.open_findings : '—'}
            </td>
            {manage && (
              <td className="py-1.5 text-right">
                {scanner.registered ? <ScannerToggle scanner={scanner} manage={manage} /> : '—'}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Re-run this one scanner (W20-13, UX_TODO FND-30). "Run scans now" always
 * runs every enabled scanner; a single one that failed after a database sync
 * could not be retried on its own, although the API takes `scanner_key`.
 */
function RerunScanner({
  scanner,
  manage,
}: {
  scanner: ScannerStatus;
  manage: { repoId: string; invalidate: readonly (readonly unknown[])[] };
}) {
  const run = useApiMutation<
    { scanner_key: string },
    { started: string[]; already_running: string[] }
  >(
    { endpoint: '/repos/{id}/scan', path: { id: manage.repoId }, method: 'POST' },
    { invalidate: manage.invalidate },
  );
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        className="text-accent underline underline-offset-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid={`scanner-rerun-${scanner.key}`}
        disabled={run.isPending}
        onClick={() => run.mutate({ scanner_key: scanner.key })}
      >
        {run.isPending ? 'Starting…' : scanner.state === 'never_run' ? 'Run it now' : 'Re-run'}
      </button>
      {run.isSuccess && (
        <span role="status" className="text-fg-muted">
          {run.data.started.length > 0 ? 'Started.' : 'Already running.'}
        </span>
      )}
      <ErrorNote error={run.error} testId={`scanner-rerun-error-${scanner.key}`} />
    </div>
  );
}

/**
 * One scanner's on/off switch for one repository (W20-08, UX_TODO FND-07).
 *
 * `PUT /scanners/:key` existed with no caller, so the opt-in image scan could
 * never be opted into and the OWASP checklists read "not enabled" for good.
 * Turning one ON asks first and says what it costs and sends; turning one OFF
 * applies at once and says the findings already stored stay. Admin-only, as
 * the API is.
 */
function ScannerToggle({
  scanner,
  manage,
}: {
  scanner: ScannerStatus;
  manage: { repoId: string; invalidate: readonly (readonly unknown[])[] };
}) {
  const [asking, setAsking] = useState(false);
  const catalogue = { endpoint: '/scanners', query: { repo_id: manage.repoId } } as const;
  const { data } = useApiQuery<{ items: { key: string; rationale: string | null }[] }>(catalogue);
  const put = useApiMutation<{ repo_id: number; enabled: boolean }, { enabled: boolean }>(
    { endpoint: '/scanners/{key}', path: { key: scanner.key }, method: 'PUT' },
    { invalidate: [...manage.invalidate, ['/scanners', {}, { repo_id: manage.repoId }]] },
  );
  const rationale = data?.items?.find((i) => i.key === scanner.key)?.rationale ?? null;
  const send = (enabled: boolean) => {
    setAsking(false);
    put.mutate({ repo_id: Number(manage.repoId), enabled });
  };

  return (
    <div className="flex flex-col items-end gap-1 text-xs">
      <button
        type="button"
        role="switch"
        aria-checked={scanner.enabled}
        aria-label={`${scanner.display_name}: ${scanner.enabled ? 'on' : 'off'} for this repository`}
        className="rounded-md border border-border px-2 py-0.5 hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid={`scanner-toggle-${scanner.key}`}
        disabled={put.isPending}
        onClick={() => (scanner.enabled ? send(false) : setAsking(true))}
      >
        {put.isPending ? 'Saving…' : scanner.enabled ? 'On · turn off' : 'Off · turn on'}
      </button>
      {asking && (
        <div
          className="flex max-w-xs flex-col items-end gap-1 text-left"
          role="alertdialog"
          aria-label={`Turn on ${scanner.display_name}?`}
          data-testid={`scanner-toggle-confirm-${scanner.key}`}
        >
          <p className="text-fg-muted">
            {SCANNER_COST[scanner.key] ?? 'Runs on its usual schedule from now on.'}
            {rationale ? ` Default off because: ${rationale}` : ''}
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`scanner-toggle-yes-${scanner.key}`}
              onClick={() => send(true)}
            >
              Turn on
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => setAsking(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {put.isSuccess && (
        <span role="status" data-testid={`scanner-toggle-done-${scanner.key}`}>
          {put.data.enabled
            ? 'On. It runs from the next scheduled or manual scan.'
            : 'Off. Findings it already stored stay as they are.'}
        </span>
      )}
      <ErrorNote error={put.error} testId={`scanner-toggle-error-${scanner.key}`} />
    </div>
  );
}

/**
 * A scanner's own failure, verbatim, plus what to do about it when the shape
 * is recognised (W16-11, W16-36). Shared with the Code Health coverage table
 * (W17-20): the code-health tools run in the same image, so a missing image
 * fails them the same way and deserves the same sentence.
 */
export function ScannerErrorDetail({ scannerKey, error }: { scannerKey: string; error: string }) {
  return (
    <div className="text-xs text-fg-muted" data-testid={`scanner-error-${scannerKey}`}>
      {error}
      {looksLikeStaleVulnDb(error) && (
        // A DIFFERENT command from the image one. grype refuses a database
        // older than five days, and the image cannot carry one — a baked-in
        // copy would ship stale and look current.
        <div className="mt-0.5" data-testid={`scanner-db-${scannerKey}`}>
          The vulnerability database is refreshed daily and is not part of the image. Run{' '}
          <code className="rounded bg-surface-2 px-1 font-mono">deploy/scan-db-sync.sh</code> on the
          host where RepoPulse runs (see INSTALL → Scan data).
        </div>
      )}
      {hasPullFailure(error) && (
        <div className="mt-0.5" data-testid={`scanner-pull-${scannerKey}`}>
          Images are pulled anonymously: an image in a private registry, or a tag that no longer
          exists, cannot be scanned. Registry credentials are not supported yet; the other images
          were scanned and their findings are listed.
        </div>
      )}
      {!looksLikeStaleVulnDb(error) && looksLikeMissingScanTools(sandboxPartOf(error)) && (
        // WHAT TO DO ABOUT IT (W16-11, F16). A screen that says a tool is
        // missing and stops there has told someone their scan failed and left
        // them to guess.
        <div className="mt-0.5" data-testid={`scanner-fix-${scannerKey}`}>
          {/* W20-17 (UX_TODO INS-22): a bundle install has no Containerfile
              and no docs/ folder; the build command is for a checkout only. */}
          The scan tools run in the RepoPulse scan image, which{' '}
          <code className="rounded bg-surface-2 px-1 font-mono">deploy/up.sh</code> loads from the
          bundle. Re-run it, and check the scan image is listed by{' '}
          <code className="rounded bg-surface-2 px-1 font-mono">podman images</code>. From a source
          checkout instead, build it with{' '}
          <code className="rounded bg-surface-2 px-1 font-mono">
            podman build -f Containerfile.scan -t localhost/repopulse/scan:dev .
          </code>
        </div>
      )}
    </div>
  );
}

/**
 * What the sandbox can run, stated under the coverage table (W17-27).
 *
 * Two lines a reader can act on before pressing Run: whether the CVE database
 * is there and how old it is (grype refuses one older than maxAgeDays, so a
 * stale database is a scan that WILL fail, not one that might), and which
 * tools this build deliberately does not run. Each unsupported tool carries
 * its reason in a title, so "why no govulncheck" is answered on the spot.
 */
export function ScanToolingNote({ tooling }: { tooling: SecurityTooling }) {
  const db = tooling.vuln_db;
  const built = db.builtAt
    ? new Date(db.builtAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs text-fg-muted" data-testid="scan-tooling">
      <div
        data-testid="vuln-db-status"
        data-present={db.present}
        data-stale={db.stale ?? 'unknown'}
      >
        {db.present ? (
          <>
            Vulnerability database: built {built ?? 'on an unknown date'}
            {db.ageDays !== null && (
              <>
                {' '}
                ({db.ageDays} day{db.ageDays === 1 ? '' : 's'} old)
              </>
            )}
            {db.stale === true && (
              <>
                {' '}
                — <strong>stale</strong>: grype refuses a database older than {db.maxAgeDays} days,
                so the CVE scan will fail until deploy/scan-db-sync.sh runs again.
              </>
            )}
            {db.stale === false && <> — current.</>}
          </>
        ) : (
          <>
            Vulnerability database: <strong>not synced</strong>
            {db.reason ? <> — {db.reason}</> : null}. CVE scanning cannot run without it, and that
            is not a clean bill of health.
          </>
        )}
      </div>
      {tooling.unsupported_tools.length > 0 && (
        <div data-testid="unsupported-tools">
          Not in this build:{' '}
          {tooling.unsupported_tools.map((t, i) => (
            <span key={t.tool}>
              {i > 0 ? ', ' : ''}
              <span className="underline decoration-dotted" title={t.reason}>
                {t.tool}
              </span>
            </span>
          ))}
          .
        </div>
      )}
    </div>
  );
}
