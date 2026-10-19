import { eq, isNotNull, and, type SQL } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';

// The decision half of `pnpm rotate:token-key` (W20-10, UX_TODO ADM-45), split
// from the process half in rotate-token-key.ts so it can be tested.
//
// TOKEN_ENC_KEY seals every stored credential: forge tokens, each connection's
// webhook secret, and model API keys. When someone who held the .env leaves,
// the key has to change — and a new key alone makes every stored secret
// undecryptable. SECURITY_CONTROLS described a "decrypt-old/encrypt-new sweep"
// that did not exist; this is it.
//
// ALL OR NOTHING. Everything is re-sealed inside one transaction, and a single
// secret that does not open under the old key rolls the lot back: a half-rotated
// database has two keys' worth of rows and no record of which is which.
//
// RE-RUNNABLE. A row that already opens under the NEW key is counted as done
// and left alone, so a run interrupted after the commit but before .env was
// updated can simply be run again.
//
// INSTALL-WIDE by nature: the key is one per install, so the CLI sweeps every
// workspace. `workspaceId` narrows it, which is what the test uses on a shared
// database and what nothing in production passes.

export interface RotateOptions {
  dryRun?: boolean;
  workspaceId?: number;
}

export interface RotateCounts {
  forgeCredentials: number;
  webhookSecrets: number;
  modelKeys: number;
  /** Already sealed under the new key (a re-run). */
  alreadyRotated: number;
}

export class RotateError extends Error {
  constructor(
    message: string,
    readonly unopenable: string[],
  ) {
    super(message);
  }
}

/** A wiped credential (a removed connection) holds nothing to re-seal. */
function empty(buf: Buffer | null): boolean {
  return buf === null || buf.length === 0;
}

export async function rotateTokenKey(
  db: Database,
  oldKey: Buffer,
  newKey: Buffer,
  opts: RotateOptions = {},
): Promise<RotateCounts> {
  if (oldKey.equals(newKey)) throw new RotateError('The new key is the same as the old one.', []);
  const counts: RotateCounts = {
    forgeCredentials: 0,
    webhookSecrets: 0,
    modelKeys: 0,
    alreadyRotated: 0,
  };
  const unopenable: string[] = [];

  /** Opens with the old key; null when it is already under the new one. */
  const reseal = (label: string, open: (key: Buffer) => string): string | null => {
    try {
      return open(oldKey);
    } catch {
      try {
        open(newKey);
        counts.alreadyRotated += 1;
      } catch {
        unopenable.push(label);
      }
      return null;
    }
  };

  const scope = (col: typeof core.forgeConnections.workspaceId): SQL | undefined =>
    opts.workspaceId === undefined ? undefined : eq(col, opts.workspaceId);

  await db.transaction(async (tx) => {
    const connections = await tx
      .select()
      .from(core.forgeConnections)
      .where(scope(core.forgeConnections.workspaceId));
    for (const c of connections) {
      const patch: Partial<typeof core.forgeConnections.$inferInsert> = {};
      if (!empty(c.credentialCiphertext)) {
        const plain = reseal(`forge_connections#${c.id} credential`, (key) =>
          credentials.decryptCredential(
            { ciphertext: c.credentialCiphertext, iv: c.credentialIv, keyVersion: c.keyVersion },
            key,
          ),
        );
        if (plain !== null) {
          const enc = credentials.encryptCredential(plain, newKey);
          patch.credentialCiphertext = enc.ciphertext;
          patch.credentialIv = enc.iv;
          patch.keyVersion = enc.keyVersion;
          counts.forgeCredentials += 1;
        }
      }
      if (!empty(c.webhookSecretCiphertext)) {
        const sealed = c.webhookSecretCiphertext as Buffer;
        const plain = reseal(`forge_connections#${c.id} webhook secret`, (key) =>
          credentials.openSecret(sealed, key),
        );
        if (plain !== null) {
          patch.webhookSecretCiphertext = credentials.sealSecret(plain, newKey);
          counts.webhookSecrets += 1;
        }
      }
      if (Object.keys(patch).length > 0 && !opts.dryRun) {
        await tx.update(core.forgeConnections).set(patch).where(eq(core.forgeConnections.id, c.id));
      }
    }

    const providers = await tx
      .select({
        id: core.llmProviders.id,
        ciphertext: core.llmProviders.credentialCiphertext,
        iv: core.llmProviders.credentialIv,
        keyVersion: core.llmProviders.keyVersion,
      })
      .from(core.llmProviders)
      .where(
        and(
          isNotNull(core.llmProviders.credentialCiphertext),
          opts.workspaceId === undefined
            ? undefined
            : eq(core.llmProviders.workspaceId, opts.workspaceId),
        ),
      );
    for (const p of providers) {
      if (empty(p.ciphertext) || p.iv === null) continue;
      const ciphertext = p.ciphertext as Buffer;
      const iv = p.iv;
      const plain = reseal(`llm_providers#${p.id} API key`, (key) =>
        credentials.decryptCredential({ ciphertext, iv, keyVersion: p.keyVersion ?? 1 }, key),
      );
      if (plain === null) continue;
      const enc = credentials.encryptCredential(plain, newKey);
      counts.modelKeys += 1;
      if (!opts.dryRun) {
        await tx
          .update(core.llmProviders)
          .set({
            credentialCiphertext: enc.ciphertext,
            credentialIv: enc.iv,
            keyVersion: enc.keyVersion,
          })
          .where(eq(core.llmProviders.id, p.id));
      }
    }

    // Thrown INSIDE the transaction, so nothing above is committed.
    if (unopenable.length > 0) {
      throw new RotateError(
        `${unopenable.length} stored secret(s) open under neither the current TOKEN_ENC_KEY nor the new one. Nothing was changed.`,
        unopenable,
      );
    }
  });

  return counts;
}
