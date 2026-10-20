import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import externalFindingsRoutes, { SARIF_MAX_BYTES } from './external.js';
import findingsRoutes from '../findings/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import type { RequestRole } from '../../lib/rbac.js';

// POST /repos/:id/external-findings/sarif (W18-24): who may upload, how much,
// what is refused before anything is stored, and that the findings API then
// says which tool a finding came from.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../../../packages/security/fixtures/external/sarif');
const codeql = readFileSync(path.join(FIXTURES, 'codeql.sarif.json'), 'utf8');

const WS = 'w18-24-upload';
const OTHER_WS = 'w18-24-upload-other';
const FP = 'w18-24-upload-fp';

describeIfDb('SARIF upload route (W18-24)', () => {
  const db = createDb(databaseUrl as string);
  let app: FastifyInstance;
  let workspaceId = 0;
  let otherWorkspaceId = 0;
  let userId = 0;
  let repoId = 0;
  let otherRepoId = 0;
  let role: RequestRole = 'admin';

  const upload = (body: string, opts: { repo?: number; query?: string; type?: string } = {}) =>
    app.inject({
      method: 'POST',
      url: `/repos/${opts.repo ?? repoId}/external-findings/sarif${opts.query ?? ''}`,
      headers: { 'content-type': opts.type ?? 'application/json' },
      payload: body,
    });

  const stored = async () =>
    db.select().from(read.findings).where(eq(read.findings.repoId, repoId));

  beforeAll(async () => {
    const ws = async (slug: string) =>
      (
        await db
          .insert(core.workspaces)
          .values({ slug, name: slug })
          .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: slug } })
          .returning()
      )[0]!.id;
    workspaceId = await ws(WS);
    otherWorkspaceId = await ws(OTHER_WS);
    userId = (
      await db
        .insert(core.users)
        .values({
          authProvider: 'local',
          authSubject: 'w18-24-upload@example.com',
          login: 'w18-24u',
        })
        .returning()
    )[0]!.id;
    const conn = async (ws: number) =>
      (
        await db
          .insert(core.forgeConnections)
          .values({
            workspaceId: ws,
            provider: 'github',
            authKind: 'pat',
            credentialCiphertext: Buffer.from('x'),
            credentialIv: Buffer.from('iv-1234567890123'),
            keyVersion: 1,
            credentialFingerprint: FP,
            status: 'active',
            createdBy: userId,
          })
          .returning()
      )[0]!.id;
    const repo = async (ws: number, name: string) =>
      (
        await db
          .insert(core.repos)
          .values({
            workspaceId: ws,
            connectionId: await conn(ws),
            forgeRepoId: `w18-24-upload-${name}`,
            org: 'acme',
            name,
            defaultBranch: 'main',
            isPrivate: true,
            isArchived: false,
            syncStatus: 'live',
            tier2Auto: false,
          })
          .returning()
      )[0]!.id;
    repoId = await repo(workspaceId, 'widgets');
    otherRepoId = await repo(otherWorkspaceId, 'theirs');

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: WS, name: WS };
      request.role = role;
    });
    await app.register(externalFindingsRoutes, { db });
    await app.register(findingsRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, ws));
      await db.delete(read.findings).where(eq(read.findings.workspaceId, ws));
      await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, ws));
      await db.delete(core.repos).where(eq(core.repos.workspaceId, ws));
    }
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, otherWorkspaceId));
    await db.$client.end();
  });

  it('a member is refused and nothing is stored', async () => {
    role = 'member';
    try {
      const res = await upload(codeql);
      expect(res.statusCode).toBe(403);
      expect(await stored()).toHaveLength(0);
    } finally {
      role = 'admin';
    }
  });

  it('an oversized body is a 413 and stores nothing', async () => {
    const huge = JSON.stringify({ version: '2.1.0', pad: 'x'.repeat(SARIF_MAX_BYTES) });
    const res = await upload(huge);
    expect(res.statusCode).toBe(413);
    expect(await stored()).toHaveLength(0);
  });

  it('an invalid log is a 400 naming the field, and stores nothing', async () => {
    const res = await upload(JSON.stringify({ version: '2.1.0', runs: [{ tool: {} }] }));
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      title: 'Not a valid SARIF 2.1.0 log',
      errors: [{ path: 'runs.0.tool.driver' }],
    });
    const runs = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.repoId, repoId));
    expect(runs).toHaveLength(0);
  });

  it('refuses a prototype-poisoning body rather than merging it', async () => {
    const res = await upload('{"version":"2.1.0","__proto__":{"admin":true},"runs":[]}');
    expect(res.statusCode).toBe(400);
  });

  it('refuses bad query parameters and an unsupported media type', async () => {
    expect((await upload(codeql, { query: '?commit_sha=main' })).statusCode).toBe(400);
    expect((await upload(codeql, { query: '?sweep=maybe' })).statusCode).toBe(400);
    expect((await upload(codeql, { query: '?source_root=relative/path' })).statusCode).toBe(400);
    // text/plain parses to a string, which is not a SARIF log.
    expect((await upload(codeql, { type: 'text/plain' })).statusCode).toBe(400);
    expect((await upload(codeql, { type: 'application/xml' })).statusCode).toBe(415);
  });

  it('another workspace’s repository is a 404', async () => {
    const res = await upload(codeql, { repo: otherRepoId });
    expect(res.statusCode).toBe(404);
  });

  it('an admin upload lands, as application/sarif+json, with per-tool counts', async () => {
    const res = await upload(codeql, { type: 'application/sarif+json' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      commit_sha: string;
      results: number;
      skipped: Record<string, number>;
      tools: { scanner_key: string; tool_version: string; created: number; scan_run_id: number }[];
    };
    expect(body).toMatchObject({
      commit_sha: '3f786850e387550fdab836ed7e6dc881de23001b',
      results: 3,
      skipped: { suppressed: 1 },
    });
    expect(body.tools).toEqual([
      expect.objectContaining({
        scanner_key: 'external:codeql',
        tool_version: '2.19.0',
        created: 3,
      }),
    ]);
    expect(await stored()).toHaveLength(3);
  });

  it('commit_sha in the query wins over the file’s own', async () => {
    const sha = 'b'.repeat(40);
    const res = await upload(codeql, { query: `?commit_sha=${sha}` });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ commit_sha: sha, tools: [{ created: 0, updated: 3 }] });
  });

  it('the findings API marks each external finding with its tool', async () => {
    const res = await app.inject({ method: 'GET', url: `/findings?repo_ids=${repoId}&limit=50` });
    expect(res.statusCode).toBe(200);
    const items = (
      res.json() as {
        items: {
          scanner_key: string;
          external: { tool: string; source: string; tool_version: string | null } | null;
          found_by: { kind: string };
        }[];
      }
    ).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.scanner_key).toBe('external:codeql');
      expect(item.external).toEqual({ tool: 'codeql', source: 'sarif', tool_version: '2.19.0' });
      // W20-15 (UX_TODO X-10): said as who found it, not as a tier.
      expect(item.found_by).toEqual({
        kind: 'imported',
        tool: 'codeql',
        source: 'sarif',
        tool_version: '2.19.0',
      });
    }
  });
});
