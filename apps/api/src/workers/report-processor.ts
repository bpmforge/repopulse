import { eq } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { createReportAssembler, renderReport, type ReportParams } from '@repopulse/reports';
import type { Job } from 'bullmq';

// reports.generate processor (W5-04, REPORTS.md §3).
//
// Status is written at every transition, not just at the end: the Report Center
// shows a status chip per row, and a report stuck at "queued" while the worker
// is actually printing is indistinguishable from a queue nobody is draining.

export interface ReportJobData {
  reportId: number;
  workspaceId: number;
  params: ReportParams;
}

export interface ReportProcessorDeps {
  db: Database;
  dataDir: string;
  printBaseUrl: string;
  /** Injectable so tests exercise the whole path without a browser. */
  printToPdf?: (url: string) => Promise<Buffer>;
}

export function reportProcessor(deps: ReportProcessorDeps) {
  return async function process(job: Job<ReportJobData>): Promise<void> {
    const { reportId, params } = job.data;

    await deps.db
      .update(read.reports)
      .set({ status: 'running', error: null })
      .where(eq(read.reports.id, reportId));

    try {
      const data = await createReportAssembler(deps.db).assemble(params);
      const result = await renderReport(data, reportId, {
        dataDir: deps.dataDir,
        printBaseUrl: deps.printBaseUrl,
        ...(deps.printToPdf ? { printToPdf: deps.printToPdf } : {}),
      });

      await deps.db
        .update(read.reports)
        .set({
          status: 'ready',
          jsonUri: result.jsonUri,
          pdfUri: result.pdfUri,
          error: null,
        })
        .where(eq(read.reports.id, reportId));
    } catch (err) {
      // The reason is stored ON the row. A report that just says "failed"
      // sends its owner to the worker logs, which they may not have.
      const message = err instanceof Error ? err.message : String(err);
      await deps.db
        .update(read.reports)
        .set({ status: 'failed', error: message.slice(0, 2000) })
        .where(eq(read.reports.id, reportId));
      // Rethrown so BullMQ counts the attempt and the DLQ eventually sees it
      // (NFR-11) — swallowing here would make a failing print look like a
      // queue that simply never ran.
      throw err;
    }
  };
}
