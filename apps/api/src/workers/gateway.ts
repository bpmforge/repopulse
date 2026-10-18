import {
  createAnalysisGateway,
  createEgressAuditor,
  resolveProviderAsync,
  type AnalysisGateway,
  type EgressAuditRow,
  type LlmProviderKind,
  type T2Host,
} from '@repopulse/analysis';
import { credentials } from '@repopulse/auth';
import { core, read, type Database } from '@repopulse/shared';
import { and, eq } from 'drizzle-orm';
import { chainsFor, loadStoredRouting } from '../lib/llm-routing.js';

// The analysis gateway, built once for the worker (carry-forward from W9-03,
// W9-04 and W9-07).
//
// UNTIL NOW NOTHING BUILT ONE. `createAnalysisGateway` was exercised only by
// its own unit test, so no scheduled pass could reach a model and the
// judgement halves of anti_slop and logging_hygiene — written, tested against
// a stub, and shipped — had never run against anything. Law 8 says every LLM
// call goes through this gateway; that was true, and the number of calls was
// zero.
//
// ABSENT IS A REAL STATE, NOT AN ERROR. A deployment with no LM Studio host is
// a supported deployment: the whole Tier-1 product works without one. So this
// returns null rather than throwing, every caller reports `no_gateway` by
// name, and nothing pretends a pass ran.

/**
 * `http://host:1234/v1,http://other:1234/v1` — the documented shape.
 *
 * `modelSlot` is sent to LM Studio as the MODEL IDENTIFIER, so it has to name a
 * model that is actually loaded. There is deliberately no default: the first
 * version of this used `'default'` and LM Studio answered
 * `Invalid model identifier "default"` — a 400 on every call, discovered by
 * making one. A guessed model name is a guess about someone else's machine.
 */
export function hostsFromEnv(env: NodeJS.ProcessEnv = process.env): T2Host[] {
  const raw = env.LMSTUDIO_BASE_URLS ?? '';
  const model = env.LMSTUDIO_MODEL ?? '';
  if (model.trim() === '') return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((baseUrl) => ({
      baseUrl,
      // One slot per host is the W6-01 default; the concurrency cap is what
      // actually bounds parallelism, and a second slot here would let two
      // chunked reviews share a model that can only hold one.
      modelSlot: model.trim(),
    }));
}

/** Why no gateway could be built, in the operator's terms. */
export function missingGatewayConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  const hasHosts = (env.LMSTUDIO_BASE_URLS ?? '').trim() !== '';
  const hasModel = (env.LMSTUDIO_MODEL ?? '').trim() !== '';
  if (!hasHosts && !hasModel) return 'LMSTUDIO_BASE_URLS and LMSTUDIO_MODEL are unset';
  if (!hasHosts) return 'LMSTUDIO_MODEL is set but LMSTUDIO_BASE_URLS is not';
  // The half-configured case is the one worth naming: hosts without a model
  // look configured and fail on every call with a 400 nobody sees.
  if (!hasModel) {
    return 'LMSTUDIO_BASE_URLS is set but LMSTUDIO_MODEL is not — LM Studio rejects a request that does not name a loaded model';
  }
  return null;
}

export interface WorkerGateway {
  gateway: AnalysisGateway;
  hosts: T2Host[];
  /** Where the hosts came from, so the boot log and the UI can say. */
  source: 'providers' | 'env';
  /** Configured rows that could not be used, each with its own reason. */
  skipped: { name: string; reason: string }[];
}

/**
 * Hosts from the llm_providers table (W16-08, D-LLM-1).
 *
 * The environment path below is now a MIGRATION PATH, not the design. A
 * standalone product whose premise is that you bring your own model cannot ask
 * people to edit a file on the host and restart a container to change it, which
 * is what LMSTUDIO_BASE_URLS required (F5).
 *
 * A row that cannot be resolved is SKIPPED WITH ITS REASON rather than throwing:
 * one mistyped provider must not take the other three down with it, and the
 * reason has to reach a screen — a provider that silently does nothing is the
 * failure mode this whole wave is about.
 */
export async function hostsFromProviders(
  db: Database,
  tokenKey: Buffer,
  /**
   * REQUIRED, and required for a reason (Law 5).
   *
   * The first version of this selected every enabled row in the table with no
   * workspace filter. On any install with more than one workspace — and the
   * seed alone creates two — that would have decrypted one tenant's API KEY and
   * used their model to analyse another tenant's diffs. A cross-tenant leak of
   * both the credential and the code.
   *
   * Not defaulted, so a caller has to say whose providers it wants rather than
   * getting "all of them" by forgetting.
   */
  workspaceId: number,
): Promise<{ hosts: T2Host[]; skipped: { name: string; reason: string }[] }> {
  const rows = await db
    .select()
    .from(core.llmProviders)
    .where(
      and(eq(core.llmProviders.enabled, true), eq(core.llmProviders.workspaceId, workspaceId)),
    );

  const hosts: T2Host[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const row of rows) {
    try {
      const apiKey =
        row.credentialCiphertext && row.credentialIv && row.keyVersion !== null
          ? credentials.decryptCredential(
              {
                ciphertext: row.credentialCiphertext,
                iv: row.credentialIv,
                keyVersion: row.keyVersion,
              },
              tokenKey,
            )
          : undefined;

      hosts.push(
        await resolveProviderAsync({
          id: row.id,
          name: row.name,
          kind: row.kind as LlmProviderKind,
          baseUrl: row.baseUrl,
          model: row.model,
          ...(apiKey ? { apiKey } : {}),
          ...(row.headers ? { headers: row.headers } : {}),
          allowPublicHost: row.allowPublicHost,
        }),
      );
    } catch (err) {
      skipped.push({ name: row.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { hosts, skipped };
}

/**
 * Builds the gateway, or null when this deployment has no Tier-2 host.
 *
 * Tier-3 is deliberately NOT wired here. It needs a per-repo opt-in flag and
 * writes a data-egress audit row (Law 8); a scheduled pass that could escalate
 * to a third-party API without a human having asked is exactly what that
 * opt-in exists to prevent. Scheduled passes are Tier-2 only.
 */
export async function buildWorkerGateway(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  tokenKey?: Buffer,
  /**
   * Whose providers to run on. Omitted means the env fallback only.
   *
   * ONE CALL BUILDS ONE WORKSPACE'S GATEWAY. The worker no longer calls this
   * directly — see createGatewayResolver below, which is what makes "each
   * workspace analyses on its own providers" true rather than aspirational.
   */
  workspaceId?: number,
): Promise<WorkerGateway | null> {
  // Configured providers first. The env path is kept so an existing install
  // does not lose its model the moment it upgrades, but it is documented as
  // deprecated and a configured provider always wins.
  let hosts: T2Host[] = [];
  let skipped: { name: string; reason: string }[] = [];
  let source: 'providers' | 'env' = 'providers';

  if (tokenKey && workspaceId !== undefined) {
    const fromDb = await hostsFromProviders(db, tokenKey, workspaceId);
    hosts = fromDb.hosts;
    skipped = fromDb.skipped;
  }

  if (hosts.length === 0) {
    hosts = hostsFromEnv(env);
    source = 'env';
  }

  if (hosts.length === 0) return null;

  // THE PRODUCTION EGRESS WRITER (W17-11).
  //
  // egress_audit had a reader and no writer: the only thing that ever wrote one
  // was createT3Client, whose only caller was its own test. So Admin → Analysis
  // reported an empty table on an install that had been sending diffs to a
  // configured PUBLIC provider all along.
  //
  // INSERT only. SC-15 grants the app role INSERT and SELECT, so an outcome is
  // an appended row sharing the attempt id, never an update.
  const egressAuditor = createEgressAuditor({
    write: async (row: EgressAuditRow) => {
      await db.insert(read.egressAudit).values({
        workspaceId: row.workspaceId,
        repoId: row.repoId,
        analysisRunId: row.analysisRunId ?? null,
        pullRequestId: row.pullRequestId ?? null,
        initiatorUserId: row.initiatorUserId ?? null,
        initiatorLogin: row.initiatorLogin ?? null,
        modelId: row.modelId,
        bytesSent: row.bytesSent,
        // Unknown stays NULL. Recording 0 would assert a measurement nobody
        // made, which is the thing an audit may never do.
        tokensSent: row.tokensSent,
        tokensReceived: row.tokensReceived,
        contentSha256: row.contentSha256,
        attemptId: row.attemptId,
        outcome: row.outcome,
        destinationHost: row.destinationHost,
        tier: row.tier,
        error: row.error,
      });
    },
  });

  // Per-role routing and the local-only switch (W19-02). Only for configured
  // providers: the deprecated env path has no connections to route between.
  const routing =
    source === 'providers' && workspaceId !== undefined
      ? await loadStoredRouting(db, workspaceId)
      : null;

  const gateway = createAnalysisGateway({
    hosts,
    ...(routing
      ? { routing: { localOnly: routing.localOnly, chains: chainsFor(routing, hosts) } }
      : {}),
    egressAuditor,
    /**
     * The gateway speaks in the string repoId its callers use; the audit table
     * is relational. Resolving here — not in the gateway — keeps the analysis
     * package free of a database dependency (ARCHITECTURE §3).
     */
    resolveAuditIds: async (meta) => {
      const numericRepoId = Number(meta.repoId);
      if (!Number.isInteger(numericRepoId)) return null;
      const [repo] = await db
        .select({ id: core.repos.id, workspaceId: core.repos.workspaceId })
        .from(core.repos)
        .where(eq(core.repos.id, numericRepoId))
        .limit(1);
      if (!repo) return null;
      return { workspaceId: repo.workspaceId, repoId: repo.id };
    },
    ...(env.LMSTUDIO_CONCURRENCY ? { concurrencyCap: Number(env.LMSTUDIO_CONCURRENCY) } : {}),
    // Read per repo, from the admin flag — never assumed, and never true for a
    // scheduled pass because no T3 transport is supplied above.
    isT3OptedIn: async (repoId: string) => {
      const [repo] = await db
        .select({ optIn: core.repos.tier3OptIn })
        .from(core.repos)
        .where(eq(core.repos.id, Number(repoId)))
        .limit(1);
      return repo?.optIn ?? false;
    },
  });

  return { gateway, hosts, source, skipped };
}

/**
 * A gateway PER WORKSPACE, built on demand (W16-19).
 *
 * The worker used to build one gateway at boot and hand it to every scan. That
 * was right while hosts came from a global environment variable and wrong the
 * moment providers became per-workspace rows (D-LLM-1): a second workspace with
 * its own model would have been analysed on the first workspace's — or, since
 * the worker passed the DEFAULT workspace's id, silently got no gateway at all
 * while its own configured provider sat there enabled.
 *
 * v1 runs one workspace, so nothing was visibly broken. That is exactly why it
 * was worth fixing before there were two: the failure mode is a workspace whose
 * configured model is quietly ignored, which is the shape of bug this whole
 * wave has been about.
 */
export interface GatewayResolver {
  /** This workspace's gateway, or null when it has no usable provider. */
  for(workspaceId: number): Promise<WorkerGateway | null>;
  /** Drops the cache — for tests, and for an admin change taking effect. */
  invalidate(workspaceId?: number): void;
}

export interface GatewayResolverOptions {
  /**
   * How long a built gateway is reused, in ms.
   *
   * Not zero, because building one decrypts a credential and resolves every
   * provider row, and a weekly pass over forty repos would do that forty times.
   * Not infinite either: D-LLM-1's premise is that you configure your model in
   * Admin → Models, and a cache with no expiry would mean an admin who adds a
   * provider has to restart the worker before anything uses it — which is the
   * file-editing-and-restarting the whole feature exists to remove.
   */
  ttlMs?: number;
  /**
   * How long an ABSENT gateway (null) is reused, in ms. Shorter than ttlMs on
   * purpose.
   *
   * The W17-30 journey found the case: the worker boots, caches "no provider"
   * for the default workspace, the operator adds a model in Admin → Models
   * and runs a scan — and for the rest of the minute the row reads "No model
   * is configured … add one in Admin → Models", which they just did. A built
   * gateway is expensive to rebuild (a decrypt, every row resolved); a null is
   * one SELECT, so it can be re-asked within seconds while a sweep over forty
   * repos still shares the answer.
   */
  absentTtlMs?: number;
  now?: () => number;
}

export function createGatewayResolver(
  db: Database,
  env: NodeJS.ProcessEnv,
  tokenKey: Buffer,
  options: GatewayResolverOptions = {},
): GatewayResolver {
  const ttlMs = options.ttlMs ?? 60_000;
  const absentTtlMs = options.absentTtlMs ?? Math.min(ttlMs, 5_000);
  const now = options.now ?? (() => Date.now());
  const cache = new Map<number, { at: number; built: WorkerGateway | null }>();

  return {
    async for(workspaceId: number): Promise<WorkerGateway | null> {
      const hit = cache.get(workspaceId);
      // A cached NULL counts, but for less long. A workspace with no provider
      // is a settled answer inside one sweep; across a minute it is the answer
      // an admin is in the middle of changing.
      if (hit && now() - hit.at < (hit.built ? ttlMs : absentTtlMs)) return hit.built;

      const built = await buildWorkerGateway(db, env, tokenKey, workspaceId);
      cache.set(workspaceId, { at: now(), built });
      return built;
    },
    invalidate(workspaceId?: number): void {
      if (workspaceId === undefined) cache.clear();
      else cache.delete(workspaceId);
    },
  };
}

/**
 * Which configured hosts actually answer, for the boot log.
 *
 * An operator who has set LMSTUDIO_BASE_URLS to a host that is off, or on a
 * network the worker cannot reach, currently learns that from findings that
 * never appear. Saying it at boot costs one request per host.
 */
export async function reportGatewayHealth(built: WorkerGateway | null): Promise<string> {
  if (!built) {
    return (
      `analysis gateway: NOT CONFIGURED — add a model in Admin → Models ` +
      `(${missingGatewayConfig()}); scheduled judgement passes will skip and say so`
    );
  }
  // Named even when the gateway is otherwise fine: a provider that was
  // configured and is being ignored is exactly what nobody would notice.
  const skipNote = built.skipped.length
    ? ` — SKIPPED ${built.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`
    : '';
  const via = built.source === 'env' ? ' via deprecated LMSTUDIO_* env vars' : '';
  const health = await built.gateway.health('T2').catch(() => ({ ok: false }));
  return health.ok
    ? `analysis gateway: ${built.hosts.length} Tier-2 host(s)${via}, first host healthy${skipNote}`
    : `analysis gateway: ${built.hosts.length} host(s)${via} CONFIGURED BUT UNREACHABLE — judgement passes will fail, not silently skip${skipNote}`;
}
