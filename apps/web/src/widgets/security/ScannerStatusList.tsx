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
                // A documented scanner with no running code. Saying so beats
                // hiding the row, which would make its absence look deliberate.
                <span className="ml-2 text-xs text-fg-muted">(not installed)</span>
              )}
            </th>
            <td className="py-1.5">
              {/* Word + glyph, never colour alone (UX_SPEC §7). */}
              <span data-testid={`scanner-state-${scanner.key}`}>
                {SCANNER_STATE_LABEL[scanner.state]}
              </span>
              {scanner.error && (
                <div className="text-xs text-fg-muted" data-testid={`scanner-error-${scanner.key}`}>
                  {scanner.error}
                </div>
              )}
            </td>
            <td className="py-1.5">{when(scanner.last_run_at)}</td>
            <td className="py-1.5 text-right tabular-nums">
              {/* A dash, not 0, when nothing has looked: a zero here is a
                  claim, and an unrun scanner has not earned it. */}
              {scanner.state === 'not_enabled' || scanner.state === 'never_run'
                ? '—'
                : scanner.open_findings}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
