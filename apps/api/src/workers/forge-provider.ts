import {
  BudgetedClient,
  GitHubProvider,
  createAuthHeaderProvider,
  createGithubExecutor,
  type ForgeProvider,
  type GitHubAuth,
} from '@repopulse/forge';
import { credentials } from '@repopulse/auth';
import { core, type Database } from '@repopulse/shared';
import { eq } from 'drizzle-orm';

// Builds the ForgeProvider ingestion runs against (W12-03).
//
// Two differences from the connect-time discovery provider in
// routes/connections/provider-factory.ts, and both are deliberate:
//
//  1. It goes through the BudgetedClient. Law 7 says the rate-limit budget is
//     law for real ingestion — discovery skips it because a connection row may
//     not exist yet, but a backfill absolutely has one.
//  2. It resolves credentials from the CONNECTION row rather than a request
//     body, decrypting with the same vault helper the API uses. No new crypto
//     is written here; a second implementation of credential handling is a
//     second thing to get wrong.

export interface WorkerProviderDeps {
  db: Database;
  tokenKey: Buffer;
  /** GHES / self-hosted forge / e2e fake. Unset = api.github.com. */
  forgeBaseUrl?: string | undefined;
}

function hostOf(url: string): string {
  return new URL(url).host;
}

/**
 * Resolve the provider for a repo, or null when the repo or its connection has
 * gone away (a purged connection mid-backfill is expected, not exceptional —
 * the job should end quietly rather than crash the worker).
 */
export async function providerForRepo(
  deps: WorkerProviderDeps,
  workspaceId: number,
  repoId: number,
): Promise<{ provider: ForgeProvider; repoFullName: string } | null> {
  const [repo] = await deps.db
    .select({
      id: core.repos.id,
      org: core.repos.org,
      name: core.repos.name,
      connectionId: core.repos.connectionId,
    })
    .from(core.repos)
    .where(eq(core.repos.id, repoId))
    .limit(1);
  if (!repo) return null;

  const [conn] = await deps.db
    .select()
    .from(core.forgeConnections)
    .where(eq(core.forgeConnections.id, repo.connectionId))
    .limit(1);
  if (!conn || conn.status !== 'active') return null;

  const credential = credentials.decryptCredential(
    { ciphertext: conn.credentialCiphertext, iv: conn.credentialIv, keyVersion: conn.keyVersion },
    deps.tokenKey,
  );
  const auth: GitHubAuth =
    conn.authKind === 'pat'
      ? { kind: 'pat', token: credential }
      : {
          kind: 'app',
          appId: process.env.GITHUB_APP_ID ?? '',
          privateKey: credential,
          installationId: conn.appInstallationId ?? '',
        };

  const base = deps.forgeBaseUrl ?? 'https://api.github.com';
  const client = new BudgetedClient({
    connectionId: conn.id,
    workspaceId,
    db: deps.db,
    executor: createGithubExecutor(),
    // SC-12 exact-host allowlist, derived from the configured base URL so a
    // self-hosted forge is permitted without widening the allowlist to a
    // wildcard.
    allowlist: [hostOf(base)],
    ...(conn.appInstallationId ? { installationId: conn.appInstallationId } : {}),
  });

  return {
    provider: new GitHubProvider({
      client,
      auth: createAuthHeaderProvider(auth),
      baseUrl: base,
    }),
    repoFullName: `${repo.org}/${repo.name}`,
  };
}
