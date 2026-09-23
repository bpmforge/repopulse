import 'dotenv/config';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { uriToPath, type ReportData, type ReportParams } from '@repopulse/reports';
import { reportProcessor, type ReportJobData } from './report-processor.js';
import type { Job } from 'bullmq';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// reports.generate, replayed (W17-26).
//
// BullMQ re-delivers a job whose worker went away mid-run — recreate the worker
// container and the job it was holding arrives again on the new one. The old
// processor took every delivery as a first delivery: it set the row back to
// `running`, re-rendered over the artifacts, and when the re-render failed,
// marked a report that had been downloadable a minute earlier `failed`. What
// is asserted here is the lifecycle against real rows: a replay of a complete
// report is a no-op that leaves the PDF bytes untouched; a replay of a ready
// report whose PDF is GONE re-renders it; a failed run records why; and the
// re-queue the retry endpoint performs runs again.

describeIfLiveInfra('reports.generate replay (W17-26)', () => {
  const db: Database = createDb(databaseUrl as string);
  const USER = 'w17-26-worker-user';
  let workspaceId: number;
  let userId: number;
  let dataDir: string;
  const reportIds: number[] = [];

  const params: ReportParams = {
    type: 'repo_health',
    workspaceId: '0',
    repoIds: [],
    windowDays: 30,
    windowEnd: '2026-09-10T00:00:00.000Z',
    snapshotAt: '2026-09-10T00:00:00.000Z',
    weightsVersion: 'v1',
    catalogVersion: 'v1',
  };

  const assemble = (p: ReportParams): Promise<ReportData> =>
    Promise.resolve({
      params: p,
      sections: [{ kind: 'summary', markdown: 'Scored 72 (B).' }],
      appendix: { definitions: [] },
      dataQuality: [],
    });

  const run = (reportId: number, printToPdf: (url: string) => Promise<Buffer>) =>
    reportProcessor({ db, dataDir, printBaseUrl: 'http://x', printToPdf, assemble })({
      data: { reportId, workspaceId, params: { ...params, workspaceId: String(workspaceId) } },
    } as Job<ReportJobData>);

  const good = () => Promise.resolve(Buffer.from('%PDF-1.4 the good one'));
  const broken = () => Promise.reject(new Error('chromium not installed on the new worker'));

  async function newReport(): Promise<number> {
    const [row] = await db
      .insert(read.reports)
      .values({
        workspaceId,
        type: 'repo_health',
        params: { ...params, workspaceId: String(workspaceId) } as unknown as Record<
          string,
          unknown
        >,
        status: 'queued',
        generatedBy: userId,
      })
      .returning({ id: read.reports.id });
    reportIds.push(row!.id);
    return row!.id;
  }

  async function rowOf(id: number) {
    const [row] = await db.select().from(read.reports).where(eq(read.reports.id, id)).limit(1);
    return row!;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repopulse-w17-26-worker-'));
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: USER, forgeUserId: USER, login: USER })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: USER } })
      .returning();
    userId = user!.id;
  });

  afterAll(async () => {
    for (const id of reportIds) await db.delete(read.reports).where(eq(read.reports.id, id));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('a replay of a READY report is a no-op that leaves the PDF bytes alone', async () => {
    const id = await newReport();
    await run(id, good);
    const ready = await rowOf(id);
    expect(ready.status).toBe('ready');
    const before = await readFile(uriToPath(ready.pdfUri!));

    // The same job, delivered again to a worker that cannot print. On the old
    // processor this ended `failed` with the error stored — over a report that
    // was downloadable a moment ago.
    await expect(run(id, broken)).resolves.toBeUndefined();

    const after = await rowOf(id);
    expect(after.status).toBe('ready');
    expect(after.error).toBeNull();
    expect(after.pdfUri).toBe(ready.pdfUri);
    expect(await readFile(uriToPath(after.pdfUri!))).toEqual(before);
  });

  it('a replay of a ready report whose PDF is GONE re-renders it', async () => {
    const id = await newReport();
    await run(id, good);
    const ready = await rowOf(id);
    await rm(uriToPath(ready.pdfUri!));

    // Not a no-op this time: the row says ready but the download is broken,
    // which is exactly the state a re-run is for.
    await run(id, () => Promise.resolve(Buffer.from('%PDF-1.4 regenerated')));
    const after = await rowOf(id);
    expect(after.status).toBe('ready');
    expect((await readFile(uriToPath(after.pdfUri!))).toString()).toContain('regenerated');
  });

  it('a failed run stores its reason, and the retry re-queue runs again to ready', async () => {
    const id = await newReport();
    await expect(run(id, broken)).rejects.toThrow('chromium not installed');
    const failed = await rowOf(id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('chromium not installed');
    expect(failed.pdfUri).toBeNull();

    // What POST /reports/:id/retry writes before it enqueues.
    await db
      .update(read.reports)
      .set({ status: 'queued', error: null })
      .where(eq(read.reports.id, id));
    await run(id, good);
    const after = await rowOf(id);
    expect(after.status).toBe('ready');
    expect(after.error).toBeNull();
    expect(after.pdfUri).not.toBeNull();
  });
});
