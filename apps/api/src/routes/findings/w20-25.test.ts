import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import findingsRoutes from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import { verifierColumns } from '../../workers/ai-pass-processor.js';

// W20-25 (UX_TODO X-10; W20_DECISIONS_2 row 7): the AI connection and model
// that judged a finding are recorded on its triage answer and returned as
// verified_by, so the panel can say "verified by <model>" next to "Found by".

describe('verifierColumns', () => {
  it('reads the connection id and name from the recorded route', () => {
    expect(verifierColumns({ providerId: 4, providerName: 'Workstation', model: 'm' })).toEqual({
      llmProviderId: 4,
      connectionName: 'Workstation',
    });
    expect(verifierColumns({ providerId: null, providerName: '' })).toEqual({
      llmProviderId: null,
      connectionName: null,
    });
    expect(verifierColumns(null)).toEqual({ llmProviderId: null, connectionName: null });
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('verified_by on findings (route)', () => {
  const db = createDb(databaseUrl as string);
  let app: FastifyInstance;
  let WS = 0;
  let repoId = 0;
  let connectionId = 0;
  let scanRunId = 0;
  let providerId = 0;
  let passId = 0;
  const findingIds: number[] = [];

  async function finding(title: string) {
    const [f] = await db
      .insert(read.findings)
      .values({
        workspaceId: WS,
        repoId,
        scanRunId,
        dimension: 'security',
        tier: 1,
        severity: 3,
        confidence: 4,
        title,
        file: 'src/a.ts',
        lineStart: 3,
        lineEnd: 3,
        evidence: 'e',
        recommendation: 'r',
        scannerKey: 'semgrep',
        dedupKey: `w20-25-${title}-${Math.random().toString(36).slice(2)}`,
        status: 'open',
      })
      .returning({ id: read.findings.id });
    findingIds.push(f!.id);
    return f!.id;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w20-25-verified', name: 'w20-25' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w20-25' } })
      .returning();
    WS = ws!.id;
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: WS,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: `w20-25-${Math.random().toString(36).slice(2)}`,
        status: 'active',
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = conn!.id;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: WS,
        connectionId,
        forgeRepoId: `w20-25-${Math.random().toString(36).slice(2)}`,
        org: 'w20-25',
        name: 'api',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    repoId = repo!.id;
    const [sr] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId: WS,
        repoId,
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: 'abc1234def',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning({ id: security.scanRuns.id });
    scanRunId = sr!.id;
    const [p] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId: WS,
        name: 'Workstation',
        kind: 'openai_compatible',
        model: 'm',
        baseUrl: 'http://127.0.0.1:1234/v1',
      })
      .returning({ id: core.llmProviders.id });
    providerId = p!.id;
    const [pass] = await db
      .insert(read.aiPassRuns)
      .values({ workspaceId: WS, repoId, paths: ['src'], status: 'succeeded' })
      .returning({ id: read.aiPassRuns.id });
    passId = pass!.id;

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: WS, slug: 't', name: 't' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: () => undefined,
      };
    });
    await app.register(findingsRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    if (findingIds.length > 0) {
      await db.delete(read.findings).where(inArray(read.findings.id, findingIds));
    }
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.id, passId));
    await db.delete(core.llmProviders).where(eq(core.llmProviders.id, providerId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.id, scanRunId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await app?.close();
    await db.$client.end();
  });

  it('names the model and connection of the newest answer, and null when none', async () => {
    const judged = await finding('judged');
    const plain = await finding('plain');
    await db.insert(read.aiTriageVerdicts).values({
      workspaceId: WS,
      findingId: judged,
      aiPassRunId: passId,
      verdict: 'real',
      confidence: 4,
      model: 'local-model-x',
      checklistVersion: 'v1',
      rationale: 'r',
      citations: [],
      llmProviderId: providerId,
      connectionName: 'Workstation',
    });

    const res = await app.inject({ method: 'GET', url: `/findings/${judged}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      verified_by: { model: 'local-model-x', connection: 'Workstation', verdict: 'real' },
    });
    expect((res.json() as { verified_by: { at: string } }).verified_by.at).toEqual(
      expect.any(String),
    );

    const none = await app.inject({ method: 'GET', url: `/findings/${plain}` });
    expect(none.json()).toMatchObject({ verified_by: null });
  });

  it('keeps the connection name after the connection is removed', async () => {
    const id = await finding('orphaned');
    const [p2] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId: WS,
        name: 'Old box',
        kind: 'openai_compatible',
        model: 'm',
        baseUrl: 'http://127.0.0.1:1234/v1',
      })
      .returning({ id: core.llmProviders.id });
    const [pass2] = await db
      .insert(read.aiPassRuns)
      .values({ workspaceId: WS, repoId, paths: ['src'], status: 'succeeded' })
      .returning({ id: read.aiPassRuns.id });
    await db.insert(read.aiTriageVerdicts).values({
      workspaceId: WS,
      findingId: id,
      aiPassRunId: pass2!.id,
      verdict: 'needs_human',
      confidence: 2,
      model: 'local-model-y',
      checklistVersion: 'v1',
      rationale: 'r',
      citations: [],
      llmProviderId: p2!.id,
      connectionName: 'Old box',
    });
    await db.delete(core.llmProviders).where(eq(core.llmProviders.id, p2!.id));
    const res = await app.inject({ method: 'GET', url: `/findings/${id}` });
    expect(res.json()).toMatchObject({
      verified_by: { model: 'local-model-y', connection: 'Old box', verdict: 'needs_human' },
    });
    await db.delete(read.findings).where(eq(read.findings.id, id));
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.id, pass2!.id));
  });
});
