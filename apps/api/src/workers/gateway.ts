import { createAnalysisGateway, type AnalysisGateway, type T2Host } from '@repopulse/analysis';
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
}

/**
 * Builds the gateway, or null when this deployment has no Tier-2 host.
 *
 * Tier-3 is deliberately NOT wired here. It needs a per-repo opt-in flag and
 * writes a data-egress audit row (Law 8); a scheduled pass that could escalate
 * to a third-party API without a human having asked is exactly what that
 * opt-in exists to prevent. Scheduled passes are Tier-2 only.
 */
export function buildWorkerGateway(db: Database, env: NodeJS.ProcessEnv = process.env): WorkerGateway | null {
  const hosts = hostsFromEnv(env);
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

  return { gateway, hosts };
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
    return `analysis gateway: NOT CONFIGURED (${missingGatewayConfig()}) — scheduled judgement passes will skip and say so`;
  }
  const health = await built.gateway.health('T2').catch(() => ({ ok: false }));
  return health.ok
    ? `analysis gateway: ${built.hosts.length} Tier-2 host(s), first host healthy`
    : `analysis gateway: ${built.hosts.length} host(s) CONFIGURED BUT UNREACHABLE — judgement passes will fail, not silently skip`;
}
