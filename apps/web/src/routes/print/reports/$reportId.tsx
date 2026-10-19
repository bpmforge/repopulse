import { useEffect } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useApiQuery } from '../../../api/useApiQuery.js';
import { ErrorNote, ReportMarkdown } from '../../../components/index.js';
import { MakePlanButton } from '../../../widgets/plans/MakePlanButton.js';

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
  // W20-15 (UX_TODO X-22): open findings only, so the heading says so.
  findings: 'Open findings',
  risk_counts: 'Risk counts',
  score_breakdown: 'Health score breakdown',
  sbom: 'SBOM',
  vex: 'VEX',
  // W18-20. Mapped summary ids also get a heading (below): the governance
  // summary opens a new topic mid-report and would otherwise run on from the
  // section above it.
  ai_governance: 'AI-authored vs human changes',
  ai_governance_measures: 'AI-authored vs human: measures',
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
  /** The column holding each row's finding id (W20-15, UX_TODO X-23). */
  findingIdColumn?: number;
  subScore?: string;
}

/**
 * Where a report's finding links point (W20-15, UX_TODO X-23).
 *
 * In the app, this page's own origin. In the PDF, the printing browser loads
 * the page from an internal address (REPORT_PRINT_BASE_URL, e.g.
 * http://web:8080) that a reader cannot open, so the pipeline injects the
 * public address as window.__REPORT_LINK_BASE and the links use that.
 */
export function reportLinkBase(): string {
  const injected = (window as unknown as { __REPORT_LINK_BASE?: unknown }).__REPORT_LINK_BASE;
  const base =
    typeof injected === 'string' && injected.length > 0 ? injected : window.location.origin;
  return base.replace(/\/+$/, '');
}

/** The absolute link to a finding in RepoPulse, or null if `v` is not an id. */
export function findingHref(v: unknown, base: string = reportLinkBase()): string | null {
  const id = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return `${base}/findings?finding=${id}`;
}

interface ReportDataShape {
  params: {
    type: string;
    windowDays: number;
    snapshotAt: string;
    windowEnd: string;
    annotation?: string;
    repoIds?: (string | number)[];
    /** Pinned at generation (W20-09, UX_TODO ADM-71); absent on older reports. */
    healthWeights?: Record<string, number>;
  };
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
  error?: string | null;
  data: ReportDataShape | null;
}

/** Health sub-score keys in words, for the Basis box's weights line. */
const WEIGHT_LABEL: Record<string, string> = {
  activity: 'activity',
  reviewHygiene: 'review hygiene',
  ciHealth: 'CI health',
  delivery: 'delivery',
  security: 'security',
  codeHealth: 'code health',
  supplyChain: 'supply chain',
};

/**
 * "activity 0.20 · review hygiene 0.30 · …" — the weights this report was
 * scored with (W20-09, UX_TODO ADM-71). Nothing in a report said which weights
 * were used, so a reader could not tell why its score differed from the
 * dashboard's after an admin changed them.
 */
export function weightsLine(weights: Record<string, number> | undefined): string {
  if (!weights || Object.keys(weights).length === 0) {
    return 'Health weights: the product defaults (generated before weights were recorded).';
  }
  return (
    'Health weights: ' +
    Object.entries(weights)
      .map(([k, v]) => `${WEIGHT_LABEL[k] ?? k} ${v.toFixed(2)}`)
      .join(' · ') +
    ' — sub-scores with no data are left out and the rest renormalized.'
  );
}

/** Still being made: the viewer polls these rather than calling them empty. */
function inFlight(status: string | undefined): boolean {
  return status === 'queued' || status === 'running';
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
  const { data, isSuccess, isError, error } = useApiQuery<ReportResponse>(
    { endpoint: '/reports/{id}', path: { id: reportId } },
    {
      enabled: injected === null,
      // W20-04 (UX_TODO ADM-09): "this page will update" has to be true. Polls
      // only while the row is queued or running, and stops once it settles.
      refetchInterval: (r) => (inFlight(r?.status) ? 3000 : false),
    },
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
    // W20-04 (UX_TODO ADM-09). Only success was ever checked, so a 403, a 404
    // or an outage read "Loading…" for ever; and a report that was still
    // generating, or had failed, was described as having "no stored data".
    return (
      <div className="flex flex-col gap-3 p-8 text-sm" data-testid="print-report-pending">
        <Link to="/reports" data-testid="print-back" className="text-xs underline print:hidden">
          ← Back to Report Center
        </Link>
        {isError ? (
          <ErrorNote error={error} testId="print-report-error" className="text-sm" />
        ) : !isSuccess ? (
          <p>Loading…</p>
        ) : inFlight(data?.status) ? (
          <p data-testid="print-report-generating">
            This report is still generating. This page will update when it is ready.
          </p>
        ) : data?.status === 'failed' ? (
          <p data-testid="print-report-failed">
            This report failed{data.error ? `: ${data.error}` : '.'} Retry it from the Report
            Center.
          </p>
        ) : (
          <p>
            This report has no stored data — its file is no longer on disk. Retry it from the Report
            Center to rebuild it.
          </p>
        )}
      </div>
    );
  }

  // Every date shown comes from the PINNED params, never from a clock. A
  // "generated at" that reads Date.now() would change the bytes on every
  // re-print of the same stored report.
  const generatedAt = new Date(report.params.windowEnd).toISOString().slice(0, 10);
  const snapshotAt = new Date(report.params.snapshotAt)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  return (
    <div
      className="mx-auto max-w-[900px] bg-bg p-8 text-fg print:max-w-none print:p-0"
      data-testid="print-report"
    >
      {/*
        W16-05 (F13). This route renders no shell — no rail, no topbar — because
        it is printed by a headless browser and every live subscription is one
        more thing that can stop `networkidle` arriving. But the same route is
        the in-app viewer a human reaches from Report Center, and for them it was
        a dead end: browser Back was the only way out.

        A single link, hidden from print, is the whole fix. `print:hidden` keeps
        it out of the PDF, so the artefact is unchanged.
      */}
      <div className="mb-4 flex flex-wrap items-center gap-4 print:hidden">
        <Link to="/reports" data-testid="print-back" className="inline-block text-xs underline">
          ← Back to Report Center
        </Link>
        {/* The retro's hand-off (W20-09, UX_TODO DSH-59): only for a human
            with a session — an injected print run has neither a session nor
            any use for a button, and print:hidden keeps it out of the PDF. */}
        {injected === null && (
          <MakePlanButton
            reportId={Number(reportId)}
            windowDays={report.params.windowDays}
            repoIds={report.params.repoIds ?? []}
          />
        )}
      </div>

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
      <section
        className="mb-6 rounded-md border border-border p-3 break-inside-avoid"
        data-testid="print-basis"
      >
        <h2 className="text-sm font-medium">Basis</h2>
        <p className="mt-1 text-xs text-fg-muted">
          All figures read metric snapshots computed at or before {snapshotAt}. Regenerating this
          report with the same scope reproduces these numbers exactly.
        </p>
        <p className="mt-1 text-xs text-fg-muted" data-testid="print-weights">
          {weightsLine(report.params.healthWeights)}
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
        <section
          key={`${section.kind}-${section.id ?? i}`}
          className="mb-6"
          data-testid={`print-section-${section.id ?? section.kind}`}
        >
          {section.kind === 'summary' && section.id && SECTION_TITLE[section.id] && (
            <h2 className={HEADING}>{SECTION_TITLE[section.id]}</h2>
          )}
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
                      {row.map((v, ci) => {
                        // A finding row links back to the finding (X-23).
                        const href = ci === section.findingIdColumn ? findingHref(v) : null;
                        return (
                          <td key={ci} className={CELL}>
                            {href ? (
                              <a
                                href={href}
                                className="text-accent underline"
                                data-testid="report-finding-link"
                              >
                                #{cell(v)}
                              </a>
                            ) : (
                              cell(v)
                            )}
                          </td>
                        );
                      })}
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
                  {((section as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map(
                    (r, ri) => (
                      <tr key={ri} className={ROW}>
                        <td className={CELL}>{cell(r.subScore)}</td>
                        <td className={CELL}>{cell(r.input)}</td>
                        <td className={CELL}>{cell(r.rawValue)}</td>
                        <td className={CELL}>{cell(r.normalized)}</td>
                        <td className={CELL}>{cell(r.weight)}</td>
                        <td className={CELL}>{cell(r.contribution)}</td>
                      </tr>
                    ),
                  )}
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
