import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  /**
   * Where a reader opens RepoPulse (PUBLIC_BASE_URL). Finding rows in the PDF
   * link here (W20-15, UX_TODO X-23): the print base is usually an internal
   * address, e.g. http://web:8080, that nobody reading the PDF can reach.
   * Defaults to the print base.
   */
  linkBaseUrl?: string;
  /** Injectable so tests can drive the pipeline without a browser. */
  printToPdf?: (url: string, data: ReportData, linkBaseUrl: string) => Promise<Buffer>;
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
async function playwrightPrint(
  url: string,
  data: ReportData,
  linkBaseUrl: string,
): Promise<Buffer> {
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
    await page.addInitScript(
      (payload) => {
        const g = globalThis as unknown as {
          __REPORT_DATA?: unknown;
          __REPORT_LINK_BASE?: unknown;
        };
        g.__REPORT_DATA = payload.data;
        g.__REPORT_LINK_BASE = payload.linkBaseUrl;
      },
      { data: data as unknown, linkBaseUrl },
    );
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
      // Data attribution (W10-02, Law 2). endoflife.date is MIT-licensed and
      // asks to be named as the source; a report that quotes an EOL date
      // without saying where it came from is a date the reader cannot check.
      footerTemplate:
        '<div style="font-size:8px;width:100%;padding:0 12mm;color:#666;display:flex;justify-content:space-between">' +
        '<span>EOL dates from endoflife.date (MIT)</span>' +
        '<span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>',
      margin: { top: '18mm', bottom: '18mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

/**
 * Write-then-rename (W17-26). A `writeFile` straight onto `report.pdf`
 * truncates the file first and fills it afterwards, so a worker recreated in
 * the middle of a re-render — BullMQ replays a stalled job on the new worker —
 * left a zero-length or half-written PDF under a row that still said `ready`.
 * The rename is atomic on one filesystem: the old bytes stay whole until the
 * new ones are complete, and a crash in between leaves only a `.tmp` beside
 * them.
 */
async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
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
  await writeAtomic(jsonPath, JSON.stringify(data, null, 2));

  const url = `${deps.printBaseUrl.replace(/\/$/, '')}/print/reports/${reportId}`;
  const linkBaseUrl = (deps.linkBaseUrl || deps.printBaseUrl).replace(/\/$/, '');
  const pdf = await (deps.printToPdf ?? playwrightPrint)(url, data, linkBaseUrl);
  const pdfPath = join(dir, 'report.pdf');
  await writeAtomic(pdfPath, pdf);

  return { jsonUri: `file://${jsonPath}`, pdfUri: `file://${pdfPath}`, bytes: pdf.byteLength };
}

/** file:// URI → path, for streaming a download back through the API. */
export function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

/**
 * Whether a stored artifact URI still points at a non-empty file (W17-26).
 *
 * The row says `ready`; this says whether the download behind it would work.
 * They disagree after a volume is recreated, a scratch dir is cleaned, or a
 * worker dies mid-write — and every screen that offered a PDF link off the
 * row alone offered a link to a 410. Zero bytes counts as absent: a truncated
 * file is a broken download with a valid path.
 */
export async function artifactPresent(uri: string | null | undefined): Promise<boolean> {
  if (!uri) return false;
  try {
    const s = await stat(uriToPath(uri));
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
