import { and, eq } from 'drizzle-orm';
import { core, type Database, safeErrorText } from '@repopulse/shared';
import { splitRepoFullName, type ForgeRepo, type ForgeTokenInfo } from '@repopulse/forge';

// Connect flow (FR-INGEST-1, INGESTION §1). Orchestration only — this module
// never imports @repopulse/auth (ARCHITECTURE §3 forbids ingest→auth), so the
// vault's encrypt and the forge smoke-call are injected. The API route
// (apps/api) composes auth + forge + this.

export type ConnectFailureKind =
  | 'bad_token'
  | 'bad_scope'
  | 'no_repos'
  /** The forge answered 404: almost always a wrong instance URL (W20-07, INS-64). */
  | 'wrong_url'
  /** TLS failed: an internal CA this process does not trust (W20-07, INS-64). */
  | 'tls_untrusted'
  /** DNS, refused, timeout, proxy refusal or a 5xx: the token was never judged. */
  | 'cannot_reach';

export class ConnectValidationError extends Error {
  constructor(
    readonly kind: ConnectFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectValidationError';
  }
}

// Node's TLS verification codes that mean "this certificate chain ends at a CA
// we do not trust" (or is otherwise unverifiable). They arrive through undici
// as the `cause` of a `fetch failed` TypeError, which octokit wraps again.
const TLS_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Every `code` and message down the cause chain (bounded: chains can cycle). */
function causeChain(err: unknown): { codes: string[]; messages: string[] } {
  const codes: string[] = [];
  const messages: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 6; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === 'string') codes.push(e.code);
    if (typeof e.message === 'string' && e.message) messages.push(e.message);
    cur = e.cause;
  }
  return { codes, messages };
}

/**
 * The underlying reason, made safe to show an admin: the deepest message (the
 * one that names the real failure, not "fetch failed"), one line, bounded, and
 * with any userinfo in a URL stripped.
 */
function safeReason(messages: string[]): string {
  const deepest = messages.at(-1) ?? 'unknown error';
  return deepest
    .replace(/\/\/[^/@\s]+@/g, '//')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/**
 * Distinct, actionable errors for each way a connect can fail (INGESTION §1).
 *
 * W20-07 (UX_TODO INS-64): everything that was not a 401/403 used to come back
 * as bad_token, "Could not validate the credential" — so an admin behind an
 * internal CA, a proxy or a typo'd host was told to replace a token the forge
 * had never even seen. Only a real 401 says the token is bad now.
 *
 * `host` names the forge in the message; it is the admin's own input, so
 * echoing it back discloses nothing.
 */
export function classifySmokeError(err: unknown, host?: string): ConnectValidationError {
  const status = (err as { status?: number } | null)?.status;
  const where = host ? ` ${host}` : ' the forge';
  if (status === 401) {
    return new ConnectValidationError('bad_token', 'Credential rejected — bad or expired token.');
  }
  if (status === 403) {
    return new ConnectValidationError(
      'bad_scope',
      'Credential lacks the required read scopes (contents, metadata, pull_requests, checks, deployments, issues).',
    );
  }
  if (status === 404) {
    return new ConnectValidationError(
      'wrong_url',
      `Could not find the repository listing at${where} (HTTP 404) — check the instance URL.`,
    );
  }
  const { codes, messages } = causeChain(err);
  if (codes.some((c) => TLS_CODES.has(c)) || messages.some((m) => /certificate/i.test(m))) {
    return new ConnectValidationError(
      'tls_untrusted',
      `Could not reach${where}: ${safeReason(messages)}. Its certificate is not trusted by RepoPulse — see Installing → "A forge with an internal-CA certificate".`,
    );
  }
  // Octokit reports a TRANSPORT failure as status 500 with a `request` and no
  // `response`; only an error without that shape is an HTTP answer.
  const transport =
    err instanceof Error &&
    'request' in err &&
    (err as { response?: unknown }).response === undefined;
  if (typeof status === 'number' && status >= 400 && !transport) {
    return new ConnectValidationError(
      'cannot_reach',
      `Could not reach${where}: it answered HTTP ${status}. Check the instance URL, or try again if the forge is down.`,
    );
  }
  return new ConnectValidationError(
    'cannot_reach',
    `Could not reach${where}: ${safeReason(messages)}. Check the instance URL, DNS, any proxy between RepoPulse and the forge, and that the forge is up.`,
  );
}

/** The encrypted-credential shape the vault produces (structural — no auth import). */
export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  keyVersion: number;
  fingerprint: string;
}
export type EncryptFn = (plaintext: string) => EncryptedBlob;

export interface CandidateRepo {
  forgeRepoId: string;
  org: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  isArchived: boolean;
  pushedAt: string | null;
}

function toCandidate(r: ForgeRepo): CandidateRepo {
  const { org, name } = splitRepoFullName(r.fullName, r.name);
  return {
    forgeRepoId: r.externalId,
    org,
    name,
    defaultBranch: r.defaultBranch,
    isPrivate: r.isPrivate,
    isArchived: r.isArchived,
    pushedAt: r.pushedAt,
  };
}

export interface CreateConnectionDeps {
  db: Database;
  encrypt: EncryptFn;
  /** Status-aware smoke listing (lane=user) — throws with `.status` on auth failure. */
  smokeListRepos: () => Promise<ForgeRepo[]>;
  /** The forge's host, named in a cannot-reach message (W20-07, INS-64). */
  host?: string | undefined;
  /**
   * The token's owner and expiry (W20-25, UX_TODO ADM-50). Optional, and a
   * failure never fails the connect: the columns stay empty and the nightly
   * sweep tries again.
   */
  readTokenInfo?: (() => Promise<ForgeTokenInfo>) | undefined;
}

/** The token columns to write, or {} when the forge could not be asked. */
export async function tokenInfoColumns(
  read: (() => Promise<ForgeTokenInfo>) | undefined,
): Promise<{
  tokenOwnerLogin?: string | null;
  tokenExpiresAt?: Date | null;
  tokenCheckedAt?: Date;
}> {
  if (!read) return {};
  try {
    const info = await read();
    return {
      tokenOwnerLogin: info.ownerLogin,
      tokenExpiresAt: info.expiresAt,
      tokenCheckedAt: new Date(),
    };
  } catch {
    return {};
  }
}

/**
 * Every page of a listing, not just the first (W20-07, UX_TODO INS-52).
 *
 * The picker, the track call and the CLI all read `items` off ONE page — 100
 * repositories on GitHub, 50 on Gitea — so in a larger organisation the quiet
 * repositories could never be selected and nothing said the list was cut. The
 * page cap is a runaway guard (a forge that keeps handing back a cursor), set
 * far above any real organisation; `truncated` says when it was hit.
 */
export const MAX_LISTING_PAGES = 200;

export async function collectAllPages<T, C>(
  listPage: (cursor?: C) => Promise<{ items: T[]; nextCursor?: C }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: C | undefined;
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const res = await listPage(cursor);
    items.push(...res.items);
    if (res.nextCursor === undefined) return { items, truncated: false };
    cursor = res.nextCursor;
  }
  return { items, truncated: true };
}

export interface CreateConnectionParams {
  workspaceId: number;
  provider: 'github' | 'gitea' | 'gitlab';
  authKind: 'pat' | 'app';
  credential: string;
  createdBy: number;
  appInstallationId?: string;
  /** This connection's forge base URL. Null = the server default (W14-02). */
  baseUrl?: string | null;
}

export interface CreateConnectionResult {
  connectionId: number;
  candidates: CandidateRepo[];
}

/**
 * Smoke-test the credential, then persist an encrypted connection row + return
 * the candidate repos for selection. Never stores plaintext (FR-AUTH-5).
 */
export async function createConnection(
  deps: CreateConnectionDeps,
  params: CreateConnectionParams,
): Promise<CreateConnectionResult> {
  let repos: ForgeRepo[];
  try {
    repos = await deps.smokeListRepos();
  } catch (err) {
    throw classifySmokeError(err, deps.host);
  }
  if (repos.length === 0) {
    throw new ConnectValidationError('no_repos', 'The credential can see no repositories.');
  }

  const enc = deps.encrypt(params.credential);
  const token = await tokenInfoColumns(deps.readTokenInfo);
  const [conn] = await deps.db
    .insert(core.forgeConnections)
    .values({
      workspaceId: params.workspaceId,
      provider: params.provider,
      authKind: params.authKind,
      credentialCiphertext: enc.ciphertext,
      credentialIv: enc.iv,
      keyVersion: enc.keyVersion,
      credentialFingerprint: enc.fingerprint,
      appInstallationId: params.appInstallationId ?? null,
      // W14-02: stored per connection, so one deployment can serve two forges.
      baseUrl: params.baseUrl ?? null,
      status: 'active',
      createdBy: params.createdBy,
      ...token,
    })
    .returning();
  if (!conn) throw new Error('connection insert returned no row');
  return { connectionId: conn.id, candidates: repos.map(toCandidate) };
}

export interface ReplaceCredentialParams {
  workspaceId: number;
  connectionId: number;
  credential: string;
}

/**
 * Re-key an existing connection (W20-07, UX_TODO INS-08).
 *
 * A pasted wrong-but-valid token, a rotated token and a lost TOKEN_ENC_KEY
 * ("must be re-entered") all had no recovery path: the only write was POST,
 * which makes a SECOND connection and leaves the tracked repositories on the
 * first. This keeps the row — and so every repo, cursor and webhook pointing at
 * it — and swaps only the credential, after the same smoke test a new
 * connection gets, so a bad replacement never overwrites a working token.
 *
 * Returns false when no such connection exists in this workspace.
 */
export async function replaceConnectionCredential(
  deps: CreateConnectionDeps,
  params: ReplaceCredentialParams,
): Promise<boolean> {
  let repos: ForgeRepo[];
  try {
    repos = await deps.smokeListRepos();
  } catch (err) {
    throw classifySmokeError(err, deps.host);
  }
  if (repos.length === 0) {
    throw new ConnectValidationError('no_repos', 'The credential can see no repositories.');
  }
  const enc = deps.encrypt(params.credential);
  // A new token has its own owner and expiry; the old one's are cleared even
  // when the forge cannot be asked, so a stale expiry never warns about it.
  const token = await tokenInfoColumns(deps.readTokenInfo);
  const updated = await deps.db
    .update(core.forgeConnections)
    .set({
      credentialCiphertext: enc.ciphertext,
      credentialIv: enc.iv,
      keyVersion: enc.keyVersion,
      credentialFingerprint: enc.fingerprint,
      status: 'active',
      tokenOwnerLogin: null,
      tokenExpiresAt: null,
      tokenCheckedAt: null,
      ...token,
    })
    .where(
      and(
        eq(core.forgeConnections.id, params.connectionId),
        eq(core.forgeConnections.workspaceId, params.workspaceId),
      ),
    )
    .returning({ id: core.forgeConnections.id });
  return updated.length > 0;
}

export interface RepoSelection {
  /** Explicit forge repo ids to connect. */
  forgeRepoIds?: string[];
  /** "all + auto-add new" — connect every candidate (auto-add-future is W2-04/05). */
  allAutoAdd?: boolean;
}

export interface ActivateReposDeps {
  db: Database;
  /** Self-contained seal (iv‖tag‖ct) for the webhook secret — it lives in a
   * SINGLE column (webhook_secret_ciphertext) with no second IV column, so it
   * must carry its own IV (never reuse the credential IV — GCM nonce reuse). */
  sealSecret: (plaintext: string) => Buffer;
  /** registerWebhook(repoFullName, secret) → hook id. */
  registerWebhook: (repoFullName: string, secret: string) => Promise<string>;
  /** enqueue backfill.plan for a repo (BullMQ, W2-02). */
  enqueuePlan: (repoId: number) => Promise<void>;
  generateSecret: () => string;
  /**
   * Opens a sealed secret (the inverse of sealSecret). With it, a connection
   * that already has a webhook secret keeps it (W20-07, UX_TODO INS-72).
   */
  openSecret?: (sealed: Buffer) => string;
}

export interface ActivateReposParams {
  workspaceId: number;
  connectionId: number;
  candidates: CandidateRepo[];
  selection: RepoSelection;
}

/**
 * Create repo rows (status=pending_backfill), register one per-connection
 * webhook secret on each selected repo, and enqueue a backfill plan per repo.
 * Returns the ids of the repos it STARTED tracking.
 *
 * W20-07 (UX_TODO INS-10, INS-72): a repo this connection already tracks is
 * left exactly as it is. Re-selecting one used to register a second hook on
 * the forge (every delivery then arrived twice), reset a live repo to
 * pending_backfill and re-queue its backfill — and "Track all" would quietly
 * un-pause every paused repo. Resuming is its own action
 * (PUT /repos/{id}/tracking).
 */
export async function activateRepos(
  deps: ActivateReposDeps,
  params: ActivateReposParams,
): Promise<number[]> {
  const selected = params.selection.allAutoAdd
    ? params.candidates
    : params.candidates.filter((c) => params.selection.forgeRepoIds?.includes(c.forgeRepoId));

  const secret = await connectionWebhookSecret(deps, params);

  const already = new Set(
    (
      await deps.db
        .select({ forgeRepoId: core.repos.forgeRepoId })
        .from(core.repos)
        .where(
          and(
            eq(core.repos.workspaceId, params.workspaceId),
            eq(core.repos.connectionId, params.connectionId),
          ),
        )
    ).map((r) => r.forgeRepoId),
  );

  const repoIds: number[] = [];
  for (const c of selected) {
    if (already.has(c.forgeRepoId)) continue;
    const [repo] = await deps.db
      .insert(core.repos)
      .values({
        workspaceId: params.workspaceId,
        connectionId: params.connectionId,
        forgeRepoId: c.forgeRepoId,
        org: c.org,
        name: c.name,
        defaultBranch: c.defaultBranch,
        isPrivate: c.isPrivate,
        isArchived: c.isArchived,
        syncStatus: 'pending_backfill',
        tier2Auto: false,
        pushedAt: c.pushedAt ? new Date(c.pushedAt) : null,
      })
      .onConflictDoUpdate({
        target: [core.repos.workspaceId, core.repos.connectionId, core.repos.forgeRepoId],
        set: { syncStatus: 'pending_backfill', pushedAt: c.pushedAt ? new Date(c.pushedAt) : null },
      })
      .returning();
    if (!repo) throw new Error('repo upsert returned no row');

    // Webhook registration is NON-FATAL, and the ordering here is the reason.
    // The repo row is already inserted and enqueuePlan comes after, so an
    // unguarded throw left the repo parked in pending_backfill with no work
    // ever queued — stuck silently and forever, with no error surfaced.
    //
    // It also fails legitimately in two supported cases, neither of them a
    // problem with the connection:
    //   - a PUBLIC repo the operator does not administer (hook creation needs
    //     admin on the repo, which reading it does not imply);
    //   - a SELF-HOSTED install with no publicly reachable URL (D1a), where
    //     GitHub could never deliver to us anyway.
    // Webhooks are a latency optimisation: backfill loads the history and the
    // nightly reconcile sweep repairs anything a missed delivery would have
    // carried. Losing them costs freshness, not correctness — so it must not
    // cost the operator the whole connection.
    try {
      await deps.registerWebhook(`${c.org}/${c.name}`, secret);
    } catch (err) {
      // Recorded, not swallowed: silently degrading to polling would leave an
      // operator wondering why updates lag.
      const message = safeErrorText(err);
      await deps.db
        .update(core.repos)
        .set({ lastError: `live updates unavailable — webhook registration failed: ${message}` })
        .where(eq(core.repos.id, repo.id));
    }

    await deps.enqueuePlan(repo.id);
    repoIds.push(repo.id);
  }
  return repoIds;
}

/**
 * The ONE webhook secret a connection signs with (W20-07, UX_TODO INS-72).
 *
 * Every "Track N repo(s)" used to mint a new secret, register the new hooks
 * with it and then overwrite the single stored secret — so the hooks on every
 * EARLIER batch kept signing with a secret nobody held any more, and each of
 * their deliveries was a 401 from then on. Nothing said so; those repositories
 * quietly fell back to the nightly reconcile. The receiver verifies against
 * one secret per connection, so the fix is that there only ever is one: made
 * on the first track call, reused by every later one.
 *
 * A stored secret that cannot be opened (TOKEN_ENC_KEY was lost and the
 * connection re-keyed) is replaced — the old hooks could not be verified
 * either way. It is stored sealed (iv‖tag‖ct, FR-AUTH-5) BEFORE any hook is
 * registered with it, so a crash mid-batch cannot leave hooks on the forge
 * signing with a secret that was never saved.
 */
async function connectionWebhookSecret(
  deps: ActivateReposDeps,
  params: ActivateReposParams,
): Promise<string> {
  const scope = and(
    eq(core.forgeConnections.id, params.connectionId),
    eq(core.forgeConnections.workspaceId, params.workspaceId),
  );
  const [conn] = await deps.db
    .select({ sealed: core.forgeConnections.webhookSecretCiphertext })
    .from(core.forgeConnections)
    .where(scope)
    .limit(1);
  if (conn?.sealed && deps.openSecret) {
    try {
      return deps.openSecret(conn.sealed);
    } catch {
      // Unopenable: fall through and replace it.
    }
  }
  const secret = deps.generateSecret();
  await deps.db
    .update(core.forgeConnections)
    .set({ webhookSecretCiphertext: deps.sealSecret(secret) })
    .where(scope);
  return secret;
}
