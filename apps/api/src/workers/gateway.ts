import {
  createAnalysisGateway,
  resolveProvider,
  type AnalysisGateway,
  type LlmProviderKind,
  type T2Host,
} from '@repopulse/analysis';
import { credentials } from '@repopulse/auth';
import { core, type Database } from '@repopulse/shared';
import { eq } from 'drizzle-orm';

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
): Promise<{ hosts: T2Host[]; skipped: { name: string; reason: string }[] }> {
  const rows = await db
    .select()
    .from(core.llmProviders)
    .where(eq(core.llmProviders.enabled, true));

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
        resolveProvider({
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
): Promise<WorkerGateway | null> {
  // Configured providers first. The env path is kept so an existing install
  // does not lose its model the moment it upgrades, but it is documented as
  // deprecated and a configured provider always wins.
  let hosts: T2Host[] = [];
  let skipped: { name: string; reason: string }[] = [];
  let source: 'providers' | 'env' = 'providers';

  if (tokenKey) {
    const fromDb = await hostsFromProviders(db, tokenKey);
    hosts = fromDb.hosts;
    skipped = fromDb.skipped;
  }

  if (hosts.length === 0) {
    hosts = hostsFromEnv(env);
    source = 'env';
  }

  if (hosts.length === 0) return null;

  const gateway = createAnalysisGateway({
    hosts,
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
