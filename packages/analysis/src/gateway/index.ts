import { T2Client, T2_DEFAULTS, T2_MAX_TOKENS, type T2Config, type T2Deps, type T2Host } from '../t2/client.js';
import {
  TierNotPermittedError,
  type AnalysisGateway,
  type CompleteOpts,
  type CompleteResult,
  type Tier,
} from './types.js';

// The dispatcher (W6-01, FR-ANALYSIS-1).

export interface GatewayDeps extends T2Deps {
  hosts: T2Host[];
  concurrencyCap?: number;
  /** Per-repo Tier-3 opt-in (admin flag). Absent = not opted in. */
  isT3OptedIn?: (repoId: string) => Promise<boolean>;
  /** Tier-3 transport. Absent = Tier-3 unavailable in this deployment. */
  t3?: (prompt: string, opts: CompleteOpts) => Promise<CompleteResult>;
}

export class HostUnavailableError extends Error {
  constructor() {
    super('No Tier-2 host is available under the configured concurrency cap.');
    this.name = 'HostUnavailableError';
  }
}

export function createAnalysisGateway(deps: GatewayDeps): AnalysisGateway {
  const config: T2Config = {
    ...T2_DEFAULTS,
    hosts: deps.hosts,
    ...(deps.concurrencyCap !== undefined ? { concurrencyCap: deps.concurrencyCap } : {}),
  };
  const t2 = new T2Client(config, deps);

  return {
    async complete(prompt, opts) {
      if (opts.tier === 'T3') {
        // Rejected, never downgraded (FR-ANALYSIS-1). A silent fall back to
        // Tier-2 would mean an operator who asked for a deep review got a
        // shallow one and no record said so.
        const optedIn = (await deps.isT3OptedIn?.(opts.meta.repoId)) ?? false;
        if (!optedIn) throw new TierNotPermittedError(opts.meta.repoId);
        if (!deps.t3) throw new Error('Tier-3 is not configured in this deployment.');
        return deps.t3(prompt, opts);
      }

      const host = t2.pickHost();
      // Null means every host is at its cap. Surfaced so the SCHEDULER parks
      // and retries, rather than an unbounded in-process queue nobody can see.
      if (!host) throw new HostUnavailableError();
      return t2.complete(prompt, { ...opts, maxTokens: T2_MAX_TOKENS }, host);
    },

    async health(tier: Tier) {
      if (tier === 'T3') return { ok: deps.t3 !== undefined };
      const host = deps.hosts[0];
      if (!host) return { ok: false };
      return t2.health(host);
    },
  };
}

export * from './types.js';
export { T2Client, T2_DEFAULTS, T2_MAX_TOKENS } from '../t2/client.js';
export type { T2Config, T2Host } from '../t2/client.js';
