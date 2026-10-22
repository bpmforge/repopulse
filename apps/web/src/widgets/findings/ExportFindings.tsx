import { buildUrl } from '../../api/client.js';

// "Export CSV / SARIF (current filters)" on Findings (W20-18, UX_TODO X-08).
//
// Plain links to GET /findings/export with the list's own filters, so the file
// holds what the list shows (every page, not just this one), up to the server's
// cap; a cut file says so inside it. The browser saves the file; the API audits
// the export. Nothing is fetched from a forge.

/** The most findings one export holds (EXPORT_CAP on the server). */
export const EXPORT_CAP = 5000;

const LINK =
  'rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export function exportHref(
  format: 'csv' | 'sarif',
  filters: Readonly<Record<string, string | undefined>>,
): string {
  return buildUrl('/findings/export', { query: { ...filters, format } });
}

export function ExportFindings({
  filters,
  total,
}: {
  filters: Readonly<Record<string, string | undefined>>;
  total: number | undefined;
}) {
  const none = total === 0;
  const over = typeof total === 'number' && total > EXPORT_CAP;
  const title = none
    ? 'Nothing matches these filters, so there is nothing to export.'
    : `Every finding matching the current filters${typeof total === 'number' ? ` (${total.toLocaleString()})` : ''}, not just this page${over ? `; the file stops at ${EXPORT_CAP.toLocaleString()} and says so` : ''}.`;
  return (
    <details className="relative" data-testid="findings-export">
      <summary className={`${LINK} cursor-pointer list-none`} title={title}>
        Export…
      </summary>
      <div className="panel absolute right-0 z-10 mt-1 flex w-72 flex-col gap-2 p-3 text-xs">
        <p className="text-fg-muted" data-testid="findings-export-scope">
          {title}
        </p>
        {none ? null : (
          <div className="flex gap-2">
            <a
              className={LINK}
              href={exportHref('csv', filters)}
              download
              data-testid="findings-export-csv"
            >
              CSV
            </a>
            <a
              className={LINK}
              href={exportHref('sarif', filters)}
              download
              data-testid="findings-export-sarif"
            >
              SARIF
            </a>
          </div>
        )}
        <p className="text-fg-faint">
          CSV opens in a spreadsheet or imports into a tracker; SARIF is the format code-scanning
          tools read. Each export is recorded in the audit log.
        </p>
      </div>
    </details>
  );
}
