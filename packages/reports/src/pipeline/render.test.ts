import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderReport, reportDir, uriToPath } from './render.js';
import type { ReportData } from '../types/index.js';

// Report artifact pipeline (W5-04, REPORTS.md §3).
//
// The real Playwright print is exercised by the e2e (it needs the web app
// running). What is pinned HERE is everything around it: where artifacts land,
// that the stored ReportData is written before the print, and byte-stability —
// the property that makes a regenerated report trustworthy rather than merely
// similar.

const DATA: ReportData = {
  params: {
    type: 'repo_health',
    workspaceId: '7',
    repoIds: ['42'],
    windowDays: 30,
    windowEnd: '2026-08-10T00:00:00.000Z',
    snapshotAt: '2026-08-10T00:00:00.000Z',
    weightsVersion: 'v1',
    catalogVersion: 'v1',
  },
  sections: [{ kind: 'summary', markdown: 'Scored 72 (B).' }],
  appendix: { definitions: [] },
  dataQuality: [{ repoId: '42', phase: 'live', partial: false, syncLagHours: 2 }],
};

describe('report artifact pipeline', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repopulse-reports-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores artifacts under DATA_DIR/reports/{workspaceId}/{id}/', async () => {
    const result = await renderReport(DATA, 99, {
      dataDir: dir,
      printBaseUrl: 'http://localhost:5173',
      printToPdf: () => Promise.resolve(Buffer.from('%PDF-1.4 fake')),
    });
    expect(uriToPath(result.jsonUri)).toBe(join(reportDir(dir, 7, 99), 'report.json'));
    expect(uriToPath(result.pdfUri)).toBe(join(reportDir(dir, 7, 99), 'report.pdf'));
  });

  it('writes the ReportData even when the print FAILS', async () => {
    // The stored data is what a regeneration re-renders. If a failed print took
    // it down with it, recovering would mean re-reading a warehouse whose
    // snapshots may have moved on — and the report would come back different.
    await expect(
      renderReport(DATA, 100, {
        dataDir: dir,
        printBaseUrl: 'http://localhost:5173',
        printToPdf: () => Promise.reject(new Error('chromium exploded')),
      }),
    ).rejects.toThrow('chromium exploded');

    const stored = JSON.parse(await readFile(join(reportDir(dir, 7, 100), 'report.json'), 'utf8'));
    expect(stored.params.snapshotAt).toBe(DATA.params.snapshotAt);
  });

  it('is byte-stable: the same stored ReportData produces identical bytes', async () => {
    // FR-REPORTS-6. The print seam is deterministic here on purpose — this
    // asserts the PIPELINE adds no per-run entropy (no timestamps in the path,
    // no re-serialization differences). The browser's own determinism is fixed
    // separately by the print route pinning Date to snapshotAt and waiting on
    // __REPORT_READY instead of a timer.
    const print = (url: string) => Promise.resolve(Buffer.from(`%PDF-1.4 ${url}`));
    const a = await renderReport(DATA, 101, { dataDir: dir, printBaseUrl: 'http://x', printToPdf: print });
    const b = await renderReport(DATA, 101, { dataDir: dir, printBaseUrl: 'http://x', printToPdf: print });
    expect(a.bytes).toBe(b.bytes);

    const firstJson = await readFile(uriToPath(a.jsonUri), 'utf8');
    const secondJson = await readFile(uriToPath(b.jsonUri), 'utf8');
    expect(secondJson).toBe(firstJson);
  });

  it('prints the report id into the URL it renders', async () => {
    // A pipeline that printed the wrong page would still produce a valid PDF.
    let seen = '';
    await renderReport(DATA, 4242, {
      dataDir: dir,
      printBaseUrl: 'http://localhost:5173/',
      printToPdf: (url) => {
        seen = url;
        return Promise.resolve(Buffer.from('%PDF'));
      },
    });
    expect(seen).toBe('http://localhost:5173/print/reports/4242');
  });
});
