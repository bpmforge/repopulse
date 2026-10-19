import { and, eq } from 'drizzle-orm';
import { core, read, type Database, safeErrorText } from '@repopulse/shared';
import {
  artifactPresent,
  createReportAssembler,
  renderReport,
  type ReportData,
  type ReportParams,
} from '@repopulse/reports';
import type { Job } from 'bullmq';
import { readWorkspaceSettings } from '../lib/workspace-settings.js';

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

/**
 * What a REPEATABLE schedule enqueues (W5-09). It has no reportId, because the
 * report row does not exist yet — the schedule fires, then a report is created.
 * Handled explicitly here: without this branch the processor would read
 * `job.data.reportId` as undefined and update zero rows, so a scheduled report
 * would look like it ran and produce nothing.
 */
export interface ScheduledReportJobData {
  scheduled: true;
  workspaceId: number;
  type: ReportParams['type'];
  windowDays: number;
}

export interface ReportProcessorDeps {
  db: Database;
  dataDir: string;
  printBaseUrl: string;
  /** Injectable so tests exercise the whole path without a browser. */
  printToPdf?: (url: string) => Promise<Buffer>;
  /** Injectable so tests exercise the lifecycle without a seeded warehouse. */
  assemble?: (params: ReportParams) => Promise<ReportData>;
}

async function createScheduledReport(
  deps: ReportProcessorDeps,
  data: ScheduledReportJobData,
): Promise<{ reportId: number; params: ReportParams }> {
  const now = new Date();
  // Pinned the way a pressed Generate pins them (W20-09, UX_TODO ADM-71).
  const { effective } = await readWorkspaceSettings(deps.db, data.workspaceId);
  const params: ReportParams = {
    type: data.type,
    workspaceId: String(data.workspaceId),
    repoIds: [],
    windowDays: data.windowDays as ReportParams['windowDays'],
    windowEnd: now.toISOString(),
    snapshotAt: now.toISOString(),
    weightsVersion: 'v1',
    healthWeights: { ...effective.healthWeights },
    catalogVersion: 'v1',
    annotation: 'Generated automatically on schedule.',
  };
  const [row] = await deps.db
    .insert(read.reports)
    .values({
      workspaceId: data.workspaceId,
      type: params.type,
      params: params as unknown as Record<string, unknown>,
      status: 'queued',
      // The schedule's creator is not tracked per firing; the row records the
      // workspace's first admin as the generator so the FK holds and the audit
      // question "who set this up" is answered by the report.scheduled event.
      generatedBy: await firstAdminId(deps, data.workspaceId),
    })
    .returning();
  return { reportId: row!.id, params };
}

async function firstAdminId(deps: ReportProcessorDeps, workspaceId: number): Promise<number> {
  const [member] = await deps.db
    .select({ userId: core.workspaceMembers.userId })
    .from(core.workspaceMembers)
    .where(
      and(
        eq(core.workspaceMembers.workspaceId, workspaceId),
        eq(core.workspaceMembers.role, 'admin'),
      ),
    )
    .limit(1);
  if (!member)
    throw new Error(`scheduled report: workspace ${workspaceId} has no admin to attribute it to`);
  return member.userId;
}

/**
 * True when this job is a REPLAY of work that already finished (W17-26).
 *
 * BullMQ re-delivers a job whose worker went away mid-run: recreate the worker
 * container while a print is in flight and the same job arrives again. If the
 * first run had already reached `ready`, the second run used to set the row
 * back to `running`, re-render over the artifacts, and — when the re-render
 * failed, as a fresh worker without a browser will — mark a report that was
 * downloadable a minute ago `failed`. The row and the files on disk are the
 * evidence of completion, so a replay of a complete report is a no-op.
 */
async function alreadyComplete(deps: ReportProcessorDeps, reportId: number): Promise<boolean> {
  const [row] = await deps.db
    .select({
      status: read.reports.status,
      pdfUri: read.reports.pdfUri,
      jsonUri: read.reports.jsonUri,
    })
    .from(read.reports)
    .where(eq(read.reports.id, reportId))
    .limit(1);
  if (!row || row.status !== 'ready') return false;
  return (await artifactPresent(row.pdfUri)) && (await artifactPresent(row.jsonUri));
}

export function reportProcessor(deps: ReportProcessorDeps) {
  return async function process(job: Job<ReportJobData | ScheduledReportJobData>): Promise<void> {
    const data = job.data;
    // A scheduled firing creates its own report row first, pinning "now" at
    // the moment the schedule ran — the same determinism rule as a manual
    // generation, just with the clock read by the scheduler.
    const { reportId, params } =
      'scheduled' in data ? await createScheduledReport(deps, data) : data;

    if (await alreadyComplete(deps, reportId)) return;

    await deps.db
      .update(read.reports)
      .set({ status: 'running', error: null })
      .where(eq(read.reports.id, reportId));

    try {
      const assemble =
        deps.assemble ?? ((p: ReportParams) => createReportAssembler(deps.db).assemble(p));
      const data = await assemble(params);
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
      const message = safeErrorText(err);
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
