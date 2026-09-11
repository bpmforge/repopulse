import { useEffect } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useApiQuery } from '../../../api/useApiQuery.js';
import { ReportMarkdown } from '../../../components/index.js';

// Print route (W5-04, REPORTS.md §3).
//
// Renders from the STORED ReportData only — never a live query. That is what
// makes a report reproducible: re-printing an old report must not pick up
// snapshots computed since, or the PDF would silently disagree with the one
// already sent to someone.
//
// No shell either (no rail, no topbar, no SSE): this page exists to be printed
// by a headless browser, and every live subscription is one more thing that can
// keep `networkidle` from ever arriving.

/**
 * A section's heading (W16-54).
 *
 * `capitalize` on the raw id turned `ci` into "Ci" and `pr_flow` into "Pr
 * Flow" — the two acronyms this product is largely about, misspelled in the
 * document customers are handed. The map covers the ids where mechanical
 * casing is wrong; everything else keeps the underscore-to-space transform,
 * so a section added later still gets a readable heading rather than nothing.
 */
const SECTION_TITLE: Record<string, string> = {
  ci: 'CI',
  pr_flow: 'PR flow',
  top_risks: 'Top risks',
  risk_counts: 'Risk counts',
  score_breakdown: 'Health score breakdown',
  sbom: 'SBOM',
  vex: 'VEX',
};

function sectionTitle(id: string | undefined): string {
  const key = id ?? '';
  const mapped = SECTION_TITLE[key];
  if (mapped) return mapped;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const Route = createFileRoute('/print/reports/$reportId')({ component: PrintReport });

interface ReportSection {
  kind: string;
  id?: string;
  markdown?: string;
  reason?: string;
  columns?: string[];
  rows?: unknown[][];
  subScore?: string;
}

interface ReportDataShape {
  params: { type: string; windowDays: number; snapshotAt: string; windowEnd: string; annotation?: string };
  sections: ReportSection[];
  appendix: { definitions: { id: string; name: string; formula: string; unit: string }[] };
  dataQuality: {
    repoId: string;
    repoName?: string;
    phase: string;
    partial: boolean;
    syncLagHours: number | null;
  }[];
}

interface ReportResponse {
  id: number;
  type: string;
  status: string;
  data: ReportDataShape | null;
}

const TITLES: Record<string, string> = {
  repo_health: 'Repository Health',
  org_exec: 'Organisation Executive Summary',
  security_posture: 'Security Posture',
  delivery_dora: 'Delivery / DORA',
  code_health: 'Code Health',
};

/**
 * Print layout (W17-26). Chrome breaks a page wherever the content happens to
 * end, and a table row split across two pages reads as two broken rows; a
 * heading orphaned at a page foot introduces nothing. `break-inside-avoid`
 * on ROWS rather than on tables: a table longer than a page with the rule on
 * the whole table is pushed to a fresh page and still split, leaving a blank
 * gap behind it. `overflow-wrap: anywhere` is what stops a long path, URL or
 * commit sha from pushing the last column past the printable width, where it
 * is clipped rather than wrapped — the A4 body is ~186mm, not the 900px this
 * page has on screen.
 */
const TABLE = 'w-full table-auto text-xs';
const ROW = 'border-t border-border break-inside-avoid';
const CELL = 'py-0.5 pr-2 align-top [overflow-wrap:anywhere]';
const HEADING = 'mb-1 text-sm font-medium break-after-avoid';

export function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  // An array or object printed `String(v)` as "[object Object]" — a cell that
  // says the table is broken rather than what the assembler put in it.
  if (Array.isArray(v)) return v.map(cell).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function PrintReport() {
  const { reportId } = Route.useParams();

  // Injected by the PDF pipeline (window.__REPORT_DATA). The printing browser
  // has no session, so fetching would 401 and the PDF would be a login-shaped
  // blank page; injection also makes "renders from the stored data, never a
  // live query" (REPORTS.md §3) true by construction rather than by intent.
  const injected = (window as unknown as { __REPORT_DATA?: ReportDataShape }).__REPORT_DATA ?? null;

  // The same route doubles as the in-app viewer for a human with a session,
  // which is why the fetch still exists — disabled when data was injected.
  const { data, isSuccess } = useApiQuery<ReportResponse>(
    { endpoint: '/reports/{id}', path: { id: reportId } },
    { enabled: injected === null },
  );

  const report = injected ?? data?.data ?? null;

  useEffect(() => {
    // The signal the PDF pipeline waits on. Set only when the content is
    // actually in the DOM — printing on a timer instead makes the output
    // depend on how busy the machine was, which is exactly what byte-stability
    // forbids (REPORTS.md §3).
    if (report) {
      (window as unknown as { __REPORT_READY?: boolean }).__REPORT_READY = true;
    }
  }, [report]);

  if (!report) {
    return (
      <div className="p-8 text-sm" data-testid="print-report-pending">
        {isSuccess ? 'This report has no stored data.' : 'Loading…'}
      </div>
    );
  }

  // Every date shown comes from the PINNED params, never from a clock. A
  // "generated at" that reads Date.now() would change the bytes on every
  // re-print of the same stored report.
  const generatedAt = new Date(report.params.windowEnd).toISOString().slice(0, 10);
  const snapshotAt = new Date(report.params.snapshotAt).toISOString().slice(0, 19).replace('T', ' ');

  return (
    <div className="mx-auto max-w-[900px] bg-bg p-8 text-fg print:max-w-none print:p-0" data-testid="print-report">
      {/*
        W16-05 (F13). This route renders no shell — no rail, no topbar — because
        it is printed by a headless browser and every live subscription is one
        more thing that can stop `networkidle` arriving. But the same route is
        the in-app viewer a human reaches from Report Center, and for them it was
        a dead end: browser Back was the only way out.

        A single link, hidden from print, is the whole fix. `print:hidden` keeps
        it out of the PDF, so the artefact is unchanged.
      */}
      <Link
        to="/reports"
        data-testid="print-back"
        className="mb-4 inline-block text-xs underline print:hidden"
      >
        ← Back to Report Center
      </Link>

      {/* Cover (REPORTS.md §5). */}
      <header className="mb-8 border-b border-border pb-4 break-inside-avoid">
        <h1 className="text-lg font-semibold" data-testid="print-title">
          {TITLES[report.params.type] ?? report.params.type}
        </h1>
        <p className="mt-1 text-xs text-fg-muted">
          {report.params.windowDays}-day window · generated {generatedAt}
        </p>
        {/* R-A11: the context someone captured at generation, on the cover
            where a reader meets it before the numbers. */}
        {report.params.annotation && (
          <p className="mt-2 text-sm" data-testid="print-annotation">
            {report.params.annotation}
          </p>
        )}
      </header>

      {/* Basis box (§5.2): what the numbers are and are not built from. */}
      <section className="mb-6 rounded-md border border-border p-3 break-inside-avoid" data-testid="print-basis">
        <h2 className="text-sm font-medium">Basis</h2>
        <p className="mt-1 text-xs text-fg-muted">
          All figures read metric snapshots computed at or before {snapshotAt}. Regenerating this
          report with the same scope reproduces these numbers exactly.
        </p>
        {report.dataQuality.length > 0 && (
          <table className={`mt-2 ${TABLE}`}>
            <thead>
              <tr className="text-left text-fg-muted">
                <th scope="col">Repository</th>
                <th scope="col">Phase</th>
                <th scope="col">Coverage</th>
                <th scope="col">Sync lag (h)</th>
              </tr>
            </thead>
            <tbody>
              {report.dataQuality.map((d) => (
                <tr key={d.repoId} className={ROW}>
                  {/* W16-05 (F11): this printed the numeric id while the next
                      paragraph of the same report used org/name. */}
                  <td className={CELL}>{d.repoName ?? d.repoId}</td>
                  <td className={CELL}>{d.phase}</td>
                  {/* Paired mark + text, never colour alone (UX_SPEC §7). */}
                  <td className={CELL}>{d.partial ? '⚠ partial' : '✓ full'}</td>
                  <td className={CELL}>{cell(d.syncLagHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {report.sections.map((section, i) => (
        <section key={`${section.kind}-${section.id ?? i}`} className="mb-6" data-testid={`print-section-${section.id ?? section.kind}`}>
          {section.kind === 'summary' && (
            // W16-03 (F10): this was a raw <p>{section.markdown}</p>, so the
            // report and the PDF built from it showed their own Markdown syntax.
            <ReportMarkdown markdown={section.markdown ?? ''} />
          )}

          {section.kind === 'no_data' && (
            // FR-REPORTS-2: never blank. The reason is the content — "no
            // findings" and "nothing has analysed this repo" are different
            // facts and a reader has to be able to tell them apart.
            <div className="panel p-3 break-inside-avoid">
              <h2 className="text-sm font-medium">{sectionTitle(section.id)}</h2>
              <p className="mt-1 text-xs text-fg-muted">{section.reason}</p>
            </div>
          )}

          {section.kind === 'table' && (
            <>
              <h2 className={HEADING}>{sectionTitle(section.id)}</h2>
              <table className={TABLE}>
                <thead>
                  <tr className="text-left text-fg-muted">
                    {(section.columns ?? []).map((c) => (
                      <th key={c} scope="col" className="pr-2 align-bottom">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(section.rows ?? []).map((row, ri) => (
                    <tr key={ri} className={ROW}>
                      {row.map((v, ci) => (
                        <td key={ci} className={CELL}>{cell(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {section.kind === 'score_breakdown' && (
            <>
              <h2 className={HEADING}>Health score breakdown</h2>
              <table className={TABLE}>
                <thead>
                  <tr className="text-left text-fg-muted">
                    <th scope="col">Sub-score</th>
                    <th scope="col">Input</th>
                    <th scope="col">Raw</th>
                    <th scope="col">Normalized</th>
                    <th scope="col">Weight</th>
                    <th scope="col">Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {((section as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r, ri) => (
                    <tr key={ri} className={ROW}>
                      <td className={CELL}>{cell(r.subScore)}</td>
                      <td className={CELL}>{cell(r.input)}</td>
                      <td className={CELL}>{cell(r.rawValue)}</td>
                      <td className={CELL}>{cell(r.normalized)}</td>
                      <td className={CELL}>{cell(r.weight)}</td>
                      <td className={CELL}>{cell(r.contribution)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      ))}

      {/* Appendix A — definitions from the catalog, so a report can never
          contradict the tooltip the same reader saw on screen. */}
      <section data-testid="print-appendix">
        <h2 className={HEADING}>Appendix A — metric definitions</h2>
        <dl className="text-xs [overflow-wrap:anywhere]">
          {report.appendix.definitions.map((d) => (
            <div key={d.id} className="mb-1.5 break-inside-avoid">
              <dt className="font-medium">
                {d.id} · {d.name} ({d.unit})
              </dt>
              <dd className="text-fg-muted">{d.formula}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
