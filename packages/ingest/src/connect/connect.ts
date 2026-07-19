import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import type { ForgeRepo } from '@repopulse/forge';

// Connect flow (FR-INGEST-1, INGESTION §1). Orchestration only — this module
// never imports @repopulse/auth (ARCHITECTURE §3 forbids ingest→auth), so the
// vault's encrypt and the forge smoke-call are injected. The API route
// (apps/api) composes auth + forge + this.

export type ConnectFailureKind = 'bad_token' | 'bad_scope' | 'no_repos';

export class ConnectValidationError extends Error {
  constructor(
    readonly kind: ConnectFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectValidationError';
  }
}

// Distinct, actionable errors for the two credential failure modes
// (INGESTION §1 validation): a rejected token vs. a token lacking read scopes.
export function classifySmokeError(err: unknown): ConnectValidationError {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) {
    return new ConnectValidationError('bad_token', 'Credential rejected — bad or expired token.');
  }
  if (status === 403) {
    return new ConnectValidationError(
      'bad_scope',
      'Credential lacks the required read scopes (contents, metadata, pull_requests, checks, deployments, issues).',
    );
  }
  return new ConnectValidationError('bad_token', 'Could not validate the credential.');
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
  const [org, name] = r.fullName.split('/');
  return {
    forgeRepoId: r.externalId,
    org: org ?? '',
    name: name ?? r.name,
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
}

export interface CreateConnectionParams {
  workspaceId: number;
  provider: 'github' | 'gitea';
  authKind: 'pat' | 'app';
  credential: string;
  createdBy: number;
  appInstallationId?: string;
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
    throw classifySmokeError(err);
  }
  if (repos.length === 0) {
    throw new ConnectValidationError('no_repos', 'The credential can see no repositories.');
  }

  const enc = deps.encrypt(params.credential);
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
      status: 'active',
      createdBy: params.createdBy,
    })
    .returning();
  if (!conn) throw new Error('connection insert returned no row');
  return { connectionId: conn.id, candidates: repos.map(toCandidate) };
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
 * Idempotent on the repo natural key so re-selecting doesn't duplicate.
 */
export async function activateRepos(
  deps: ActivateReposDeps,
  params: ActivateReposParams,
): Promise<number[]> {
  const selected = params.selection.allAutoAdd
    ? params.candidates
    : params.candidates.filter((c) => params.selection.forgeRepoIds?.includes(c.forgeRepoId));

  const secret = deps.generateSecret();
  const repoIds: number[] = [];
  for (const c of selected) {
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
    await deps.registerWebhook(`${c.org}/${c.name}`, secret);
    await deps.enqueuePlan(repo.id);
    repoIds.push(repo.id);
  }

  // Store the per-connection webhook secret sealed (iv‖tag‖ct) at rest
  // (FR-AUTH-5) so the webhook receiver (W2-04) can decrypt it to verify
  // signatures.
  await deps.db
    .update(core.forgeConnections)
    .set({ webhookSecretCiphertext: deps.sealSecret(secret) })
    .where(
      and(
        eq(core.forgeConnections.id, params.connectionId),
        eq(core.forgeConnections.workspaceId, params.workspaceId),
      ),
    );
  return repoIds;
}
