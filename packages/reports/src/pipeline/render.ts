import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReportData } from '../types/index.js';

// PDF pipeline (W5-04, REPORTS.md §3).
//
// Playwright is the print engine, sanctioned in TECH_STACK.md ("doubles as the
// PDF engine") — no new dependency. It is imported LAZILY inside the render
// call so that importing this package (the API does, for its types) never
// pulls a browser driver into a process that will not print.

/** Where a report's artifacts live. REPORTS.md §3: local volume, URI-shaped. */
export function reportDir(dataDir: string, workspaceId: number, reportId: number): string {
  // RESOLVED to an absolute path. DATA_DIR defaults to './.data', and the
  // worker and the API run with different working directories under
  // `pnpm --filter` — so a relative URI written by the worker pointed at
  // nothing from the API, and a report that generated perfectly failed to
  // download with "artifact is gone".
  return resolve(join(dataDir, 'reports', String(workspaceId), String(reportId)));
}

export interface RenderDeps {
  dataDir: string;
  /** Base URL of the web app serving /print/reports/:id. */
  printBaseUrl: string;
  /** Injectable so tests can drive the pipeline without a browser. */
  printToPdf?: (url: string, data: ReportData) => Promise<Buffer>;
}

export interface RenderResult {
  jsonUri: string;
  pdfUri: string;
  bytes: number;
}

/**
 * Playwright print with everything that makes the bytes reproducible fixed:
 * a pinned viewport, no animations, and a wait for the page to say it is
 * ready rather than a timeout race (REPORTS.md §3 byte-stability).
 */
async function playwrightPrint(url: string, data: ReportData): Promise<Buffer> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    // The ReportData is INJECTED, not fetched. Two reasons, both load-bearing:
    // this browser has no session, so an authenticated fetch would 401 and the
    // PDF would be a login-shaped blank; and REPORTS.md §3 requires the print
    // to render from the STORED data with no live queries, which injection
    // guarantees rather than merely intends.
    // `globalThis`, not `window`: this callback is serialized and run in the
    // browser, but it is TYPE-CHECKED here, where no DOM lib is configured.
    await page.addInitScript((payload) => {
      (globalThis as unknown as { __REPORT_DATA?: unknown }).__REPORT_DATA = payload;
    }, data as unknown);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // The print route sets this once every chart has rendered. Printing on a
    // timer instead produces a PDF whose contents depend on how busy the
    // machine was — the exact thing byte-stability forbids.
    await page.waitForFunction('window.__REPORT_READY === true', undefined, { timeout: 30_000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div style="font-size:8px;width:100%;padding:0 12mm;color:#666"></div>',
      footerTemplate:
        '<div style="font-size:8px;width:100%;padding:0 12mm;color:#666;text-align:right">' +
        '<span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      margin: { top: '18mm', bottom: '18mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

/**
 * Stores the ReportData, prints it, stores the PDF. Returns URIs, never blobs —
 * the DB holds pointers (REPORTS.md §3) so a report is downloadable without
 * loading megabytes through Postgres.
 */
export async function renderReport(
  data: ReportData,
  reportId: number,
  deps: RenderDeps,
): Promise<RenderResult> {
  const workspaceId = Number(data.params.workspaceId);
  const dir = reportDir(deps.dataDir, workspaceId, reportId);
  await mkdir(dir, { recursive: true });

  const jsonPath = join(dir, 'report.json');
  // Stored BEFORE printing: if the print fails, the data that produced it is
  // still on disk and a regeneration does not have to re-read the warehouse
  // (whose snapshots may have moved on).
  await writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');

  const url = `${deps.printBaseUrl.replace(/\/$/, '')}/print/reports/${reportId}`;
  const pdf = await (deps.printToPdf ?? playwrightPrint)(url, data);
  const pdfPath = join(dir, 'report.pdf');
  await writeFile(pdfPath, pdf);

  return { jsonUri: `file://${jsonPath}`, pdfUri: `file://${pdfPath}`, bytes: pdf.byteLength };
}

/** file:// URI → path, for streaming a download back through the API. */
export function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}
