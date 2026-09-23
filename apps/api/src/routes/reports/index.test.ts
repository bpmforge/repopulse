import 'dotenv/config';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { reportDir, type ReportParams } from '@repopulse/reports';
import reportsRoutes from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Report Center API lifecycle (W17-26), against real rows.
//
// The routes are mounted standalone with the session and workspace decorated
// by a hook, so no Redis is needed: what the worker would do is done to the
// row directly, and what the API would enqueue is captured. The e2e spec
// covers the same path with a real worker and a real browser; what is pinned
// HERE is the contract the screen relies on — `has_pdf` is a fact about the
// disk rather than the row's memory, a ready report whose PDF is gone says
// so instead of offering a link to a 410, a failed report can be queued again
// with its pinned params, and nothing in flight can be retried under itself.

const CSRF = { 'x-requested-with': 'repopulse' };

interface ListItem {
  id: number;
  status: string;
  has_pdf: boolean;
  artifact_missing: boolean;
  error: string | null;
}

describeIfLiveInfra('reports API lifecycle (W17-26)', () => {
  const db: Database = createDb(databaseUrl as string);
  const USER = 'w17-26-api-user';
  let app: FastifyInstance;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let userId: number;
  let dataDir: string;
  const enqueued: { reportId: number; params: ReportParams }[] = [];
  const created: number[] = [];

  const mount = async (ws: () => number): Promise<FastifyInstance> => {
    const f = Fastify();
    await f.register(errorEnvelopePlugin);
    f.addHook('onRequest', async (request) => {
      request.workspace = { id: ws(), slug: 't', name: 't' };
      (request as unknown as { session: { get: (k: string) => unknown } }).session = {
        get: (k: string) => (k === 'userId' ? userId : undefined),
      };
    });
    await f.register(reportsRoutes, {
      db,
      enqueueReport: async ({ reportId, params }) => {
        enqueued.push({ reportId, params });
      },
    });
    await f.ready();
    return f;
  };

  const get = async (url: string) => app.inject({ method: 'GET', url });
  const listItem = async (id: number): Promise<ListItem> => {
    const res = await get('/reports');
    expect(res.statusCode).toBe(200);
    const item = (res.json() as { items: ListItem[] }).items.find((i) => i.id === id);
    if (!item) throw new Error(`report ${id} missing from the list`);
    return item;
  };

  /** What the worker writes when a print succeeds. */
  async function workerFinishes(id: number, pdf = '%PDF-1.4 real enough'): Promise<string> {
    const dir = reportDir(dataDir, workspaceId, id);
    await mkdir(dir, { recursive: true });
    const jsonPath = join(dir, 'report.json');
    const pdfPath = join(dir, 'report.pdf');
    await writeFile(
      jsonPath,
      JSON.stringify({
        params: {
          type: 'repo_health',
          windowDays: 30,
          snapshotAt: '2026-09-10T00:00:00.000Z',
          windowEnd: '2026-09-10T00:00:00.000Z',
        },
        sections: [{ kind: 'summary', markdown: 'ok' }],
        appendix: { definitions: [] },
        dataQuality: [],
      }),
    );
    await writeFile(pdfPath, pdf);
    await db
      .update(read.reports)
      .set({
        status: 'ready',
        jsonUri: `file://${jsonPath}`,
        pdfUri: `file://${pdfPath}`,
        error: null,
      })
      .where(eq(read.reports.id, id));
    return pdfPath;
  }

  async function generate(): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/reports',
      headers: CSRF,
      payload: { type: 'repo_health', window_days: 30, annotation: 'w17-26' },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: number }).id;
    created.push(id);
    return id;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repopulse-w17-26-api-'));
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [other] = await db
      .insert(core.workspaces)
      .values({ slug: 'w17-26-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    otherWorkspaceId = other!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: USER, forgeUserId: USER, login: USER })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: USER } })
      .returning();
    userId = user!.id;
    app = await mount(() => workspaceId);
  });

  afterAll(async () => {
    if (created.length > 0) await db.delete(read.reports).where(inArray(read.reports.id, created));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, otherWorkspaceId));
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('generate → queued → ready → view → download, and a reload reads the same ready state', async () => {
    const id = await generate();
    expect(enqueued.at(-1)?.reportId).toBe(id);

    let item = await listItem(id);
    expect(item).toMatchObject({ status: 'queued', has_pdf: false, artifact_missing: false });

    await workerFinishes(id);

    // Two independent reads — what a reload does — both say ready with a PDF.
    for (let i = 0; i < 2; i += 1) {
      item = await listItem(id);
      expect(item).toMatchObject({ status: 'ready', has_pdf: true, artifact_missing: false });
    }
    const view = await get(`/reports/${id}`);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ status: 'ready', has_pdf: true });
    expect((view.json() as { data: { sections: unknown[] } }).data.sections).toHaveLength(1);

    const download = await get(`/reports/${id}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.body.startsWith('%PDF')).toBe(true);
  });

  it('a ready report whose PDF is gone says so, and can be queued again with its pinned params', async () => {
    const id = await generate();
    const pdfPath = await workerFinishes(id);
    const pinned = (await get(`/reports/${id}`)).json() as { params: ReportParams };

    await rm(pdfPath);

    // The row still says ready. The old list answered has_pdf: true here —
    // a PDF link that opened a 410.
    const item = await listItem(id);
    expect(item).toMatchObject({ status: 'ready', has_pdf: false, artifact_missing: true });
    expect((await get(`/reports/${id}/download`)).statusCode).toBe(410);

    const retry = await app.inject({ method: 'POST', url: `/reports/${id}/retry`, headers: CSRF });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ id, status: 'queued' });
    // The SAME snapshot pin: a retry measures the moment the original was
    // asked to measure, which "generate another one" would not.
    expect(enqueued.at(-1)).toMatchObject({
      reportId: id,
      params: { snapshotAt: pinned.params.snapshotAt },
    });
    expect(await listItem(id)).toMatchObject({
      status: 'queued',
      has_pdf: false,
      artifact_missing: false,
    });
  });

  it('a failed report retries once however many people press the button; in-flight and intact reports refuse', async () => {
    const id = await generate();
    await db
      .update(read.reports)
      .set({ status: 'failed', error: 'chromium exploded' })
      .where(eq(read.reports.id, id));
    expect(await listItem(id)).toMatchObject({ status: 'failed', error: 'chromium exploded' });

    const before = enqueued.length;
    const presses = await Promise.all(
      [1, 2, 3].map(() =>
        app.inject({ method: 'POST', url: `/reports/${id}/retry`, headers: CSRF }),
      ),
    );
    const codes = presses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 409, 409]);
    expect(enqueued.length - before).toBe(1);
    expect(await listItem(id)).toMatchObject({ status: 'queued', error: null });

    // Queued and running are in flight: a second job over the same files
    // would race the first.
    expect(
      (await app.inject({ method: 'POST', url: `/reports/${id}/retry`, headers: CSRF })).statusCode,
    ).toBe(409);
    await db.update(read.reports).set({ status: 'running' }).where(eq(read.reports.id, id));
    expect(
      (await app.inject({ method: 'POST', url: `/reports/${id}/retry`, headers: CSRF })).statusCode,
    ).toBe(409);

    // Ready with its PDF present: nothing to retry.
    await workerFinishes(id);
    expect(
      (await app.inject({ method: 'POST', url: `/reports/${id}/retry`, headers: CSRF })).statusCode,
    ).toBe(409);
  });

  it('another workspace cannot see, download or retry the report (Law 5: 404, never 403)', async () => {
    const id = await generate();
    await workerFinishes(id);
    const foreign = await mount(() => otherWorkspaceId);
    try {
      expect((await foreign.inject({ method: 'GET', url: `/reports/${id}` })).statusCode).toBe(404);
      expect(
        (await foreign.inject({ method: 'GET', url: `/reports/${id}/download` })).statusCode,
      ).toBe(404);
      expect(
        (await foreign.inject({ method: 'POST', url: `/reports/${id}/retry`, headers: CSRF }))
          .statusCode,
      ).toBe(404);
    } finally {
      await foreign.close();
    }
  });
});
