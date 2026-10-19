import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { core, createDb, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { rotateTokenKey, RotateError } from './rotate-token-key-run.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// `pnpm rotate:token-key` (W20-10, UX_TODO ADM-45): re-seal every stored
// secret under a new TOKEN_ENC_KEY, all or nothing. Scoped to a workspace of
// its own, because the database is shared with other suites.
describeIfLiveInfra('rotateTokenKey (W20-10)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connId: number;
  let providerId: number;
  const OLD = randomBytes(32);
  const NEW = randomBytes(32);

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w20-10-rotate', name: 'Rotate' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Rotate' } })
      .returning();
    workspaceId = ws!.id;
  });

  beforeEach(async () => {
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    const cred = credentials.encryptCredential('ghp_forge_token', OLD);
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: cred.ciphertext,
        credentialIv: cred.iv,
        keyVersion: cred.keyVersion,
        credentialFingerprint: 'w20-10-rotate',
        webhookSecretCiphertext: credentials.sealSecret('hook-secret', OLD),
        status: 'active',
      })
      .returning();
    connId = conn!.id;
    const key = credentials.encryptCredential('sk-model-key', OLD);
    const [p] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId,
        name: 'w20-10-rotate',
        kind: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'm',
        credentialCiphertext: key.ciphertext,
        credentialIv: key.iv,
        keyVersion: key.keyVersion,
        credentialFingerprint: key.fingerprint,
      })
      .returning();
    providerId = p!.id;
  });

  afterAll(async () => {
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  async function stored() {
    const [c] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, connId));
    const [p] = await db
      .select()
      .from(core.llmProviders)
      .where(eq(core.llmProviders.id, providerId));
    return { c: c!, p: p! };
  }

  it('a dry run counts everything and changes nothing', async () => {
    const before = await stored();
    const counts = await rotateTokenKey(db, OLD, NEW, { dryRun: true, workspaceId });
    expect(counts).toEqual({
      forgeCredentials: 1,
      webhookSecrets: 1,
      modelKeys: 1,
      alreadyRotated: 0,
    });
    const after = await stored();
    expect(after.c.credentialCiphertext.equals(before.c.credentialCiphertext)).toBe(true);
  });

  it('re-seals every secret under the new key, and a re-run is a no-op', async () => {
    await rotateTokenKey(db, OLD, NEW, { workspaceId });
    const { c, p } = await stored();
    expect(
      credentials.decryptCredential(
        { ciphertext: c.credentialCiphertext, iv: c.credentialIv, keyVersion: c.keyVersion },
        NEW,
      ),
    ).toBe('ghp_forge_token');
    expect(credentials.openSecret(c.webhookSecretCiphertext as Buffer, NEW)).toBe('hook-secret');
    expect(
      credentials.decryptCredential(
        {
          ciphertext: p.credentialCiphertext as Buffer,
          iv: p.credentialIv as Buffer,
          keyVersion: 1,
        },
        NEW,
      ),
    ).toBe('sk-model-key');
    expect(() => credentials.openSecret(c.webhookSecretCiphertext as Buffer, OLD)).toThrow();

    const again = await rotateTokenKey(db, OLD, NEW, { workspaceId });
    expect(again).toEqual({
      forgeCredentials: 0,
      webhookSecrets: 0,
      modelKeys: 0,
      alreadyRotated: 3,
    });
  });

  it('one secret under neither key rolls the whole sweep back', async () => {
    await db
      .update(core.llmProviders)
      .set({ credentialCiphertext: credentials.encryptCredential('x', randomBytes(32)).ciphertext })
      .where(eq(core.llmProviders.id, providerId));
    const before = await stored();
    await expect(rotateTokenKey(db, OLD, NEW, { workspaceId })).rejects.toBeInstanceOf(RotateError);
    const after = await stored();
    // The forge credential, processed first, was NOT committed.
    expect(after.c.credentialCiphertext.equals(before.c.credentialCiphertext)).toBe(true);
  });

  it('refuses the same key twice', async () => {
    await expect(rotateTokenKey(db, OLD, OLD, { workspaceId })).rejects.toThrow(/same/);
  });
});
