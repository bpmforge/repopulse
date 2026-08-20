import {
  BudgetedClient,
  DEFAULT_GITHUB_BASE_URL,
  createAuthHeaderProvider,
  createGithubExecutor,
  type ForgeProvider,
  type GitHubAuth,
} from '@repopulse/forge';
import { providerForKind, type ForgeKind } from '../routes/connections/provider-factory.js';
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
  /** Operator opt-in for an http loopback forge (the e2e fake). SC-12. */
  allowInsecureLoopback?: boolean | undefined;
}

// `hostname`, NOT `host`: validateBaseUrl matches the allowlist against
// URL.hostname, which excludes the port. Deriving the entry from `host` put a
// port in it, so a self-hosted forge on a non-default port
// (https://git.corp.com:8443) could never match its own allowlist entry and was
// rejected outright — invisible on api.github.com, where 443 leaves `host`
// port-less. D1a puts self-hosted forges in the MVP, so this is a real path.
function hostOf(url: string): string {
  return new URL(url).hostname;
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

  // PER-CONNECTION base URL (W14-02), falling back to the server default only
  // when the row has none. FORGE_BASE_URL becomes the default, not the only
  // answer — a self-hosted Gitea and github.com can now be two connections in
  // one workspace, which a server-level env could not express.
  const base = conn.baseUrl ?? deps.forgeBaseUrl ?? DEFAULT_GITHUB_BASE_URL;

  // LAZY BACKFILL. An existing connection was created under whatever
  // FORGE_BASE_URL said at the time; writing that value onto the row the first
  // time we resolve it means a later change to the env does not silently move
  // connections that were made against a different host.
  if (!conn.baseUrl) {
    await deps.db
      .update(core.forgeConnections)
      .set({ baseUrl: base })
      .where(eq(core.forgeConnections.id, conn.id));
  }
  const client = new BudgetedClient({
    connectionId: conn.id,
    workspaceId,
    db: deps.db,
    executor: createGithubExecutor(),
    // SC-12 exact-host allowlist, derived from the configured base URL so a
    // self-hosted forge is permitted without widening the allowlist to a
    // wildcard.
    allowlist: [hostOf(base)],
    ...(deps.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    ...(conn.appInstallationId ? { installationId: conn.appInstallationId } : {}),
  });

  return {
    // BY THE CONNECTION'S DECLARED FORGE, not always GitHub. Until W14-02 this
    // built a GitHubProvider for every connection, so a Gitea connection would
    // have ingested through GitHub's API shapes and failed in ways that read
    // as a broken instance rather than as the wrong adapter.
    // Through the SINGLE construction site in routes/connections rather than a
    // second switch here: the capability gate allows exactly one file to
    // branch on the forge kind, and two construction sites are two places for
    // a new forge to be half-added.
    provider: providerForKind(conn.provider as ForgeKind, {
      client,
      auth: createAuthHeaderProvider(auth),
      baseUrl: base,
    }),
    repoFullName: `${repo.org}/${repo.name}`,
  };
}
