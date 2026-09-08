import { T2Client, T2_DEFAULTS, T2_MAX_TOKENS, type T2Config, type T2Deps, type T2Host } from '../t2/client.js';
import {
  contentDigest,
  isLocalHost,
  type EgressAuditor,
} from './egress-auditor.js';
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
  /**
   * Records outbound requests that leave the operator's network (W17-11).
   *
   * Absent means no auditing, which is correct ONLY for a deployment whose
   * hosts are all local — buildWorkerGateway supplies one whenever a workspace
   * id is known. A call to a NON-LOCAL host with no auditor is refused rather
   * than sent unrecorded: an un-auditable egress is worse than a failed
   * analysis.
   */
  egressAuditor?: EgressAuditor;
  /**
   * Resolves the numeric ids the audit row needs. The gateway speaks in the
   * string repoId its callers use; the audit table is relational.
   */
  resolveAuditIds?: (
    meta: { repoId: string; initiator: string },
  ) => Promise<{ workspaceId: number; repoId: number; initiatorUserId?: number | null } | null>;
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

  /**
   * Wrap one outbound call in an audit, when it actually leaves the network.
   *
   * A LAN model is not egress and is not audited — auditing it would bury the
   * rows that matter under thousands that do not. Everything else is audited
   * BEFORE dispatch, and refused outright if it cannot be.
   */
  async function withEgressAudit<T>(
    destinationUrl: string,
    tier: number,
    modelId: string,
    prompt: string,
    meta: { repoId: string; initiator: string },
    send: () => Promise<T>,
    usageOf: (result: T) => { tokensSent: number | null; tokensReceived: number | null },
  ): Promise<T> {
    let host: string;
    try {
      host = new URL(destinationUrl).host;
    } catch {
      host = destinationUrl;
    }

    if (isLocalHost(host)) return send();

    if (!deps.egressAuditor || !deps.resolveAuditIds) {
      // Fail CLOSED. Sending unrecorded would be the exact defect W17-11 exists
      // to close, and a deployment that cannot audit must not silently egress.
      throw new Error(
        `Refusing to send analysis to ${host}: this deployment cannot record a data-egress audit row, and an un-auditable egress is not permitted (NFR-9).`,
      );
    }

    const ids = await deps.resolveAuditIds(meta);
    if (!ids) {
      throw new Error(
        `Refusing to send analysis to ${host}: the workspace and repository behind this request could not be resolved, so the egress could not be attributed.`,
      );
    }

    const attempt = await deps.egressAuditor.begin({
      workspaceId: ids.workspaceId,
      repoId: ids.repoId,
      tier,
      modelId,
      destinationHost: host,
      bytesSent: Buffer.byteLength(prompt, 'utf8'),
      contentSha256: contentDigest(prompt),
      initiatorUserId: ids.initiatorUserId ?? null,
      initiatorLogin: meta.initiator,
    });

    try {
      const result = await send();
      await attempt.settle('succeeded', usageOf(result));
      return result;
    } catch (err) {
      // The bytes left this network whether or not an answer came back — which
      // is precisely the case a single after-the-fact row could never record.
      await attempt.settle('failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return {
    async complete(prompt, opts) {
      if (opts.tier === 'T3') {
        // Rejected, never downgraded (FR-ANALYSIS-1). A silent fall back to
        // Tier-2 would mean an operator who asked for a deep review got a
        // shallow one and no record said so.
        const optedIn = (await deps.isT3OptedIn?.(opts.meta.repoId)) ?? false;
        if (!optedIn) {
          // A refused request is recorded too: a blocked attempt is exactly
          // what an auditor wants to see, and its bytesSent is 0 because
          // nothing was sent.
          const ids = await deps.resolveAuditIds?.(opts.meta);
          if (deps.egressAuditor && ids) {
            await deps.egressAuditor.denied(
              {
                workspaceId: ids.workspaceId,
                repoId: ids.repoId,
                tier: 3,
                modelId: 'tier3',
                destinationHost: 'anthropic',
                contentSha256: contentDigest(prompt),
                initiatorUserId: ids.initiatorUserId ?? null,
                initiatorLogin: opts.meta.initiator,
              },
              'Tier-3 is not opted in for this repository.',
            );
          }
          throw new TierNotPermittedError(opts.meta.repoId);
        }
        if (!deps.t3) throw new Error('Tier-3 is not configured in this deployment.');
        return withEgressAudit(
          'https://api.anthropic.com',
          3,
          'tier3',
          prompt,
          opts.meta,
          () => deps.t3!(prompt, opts),
          (r) => ({ tokensSent: r.tokensIn, tokensReceived: r.tokensOut }),
        );
      }

      const host = t2.pickHost();
      // Null means every host is at its cap. Surfaced so the SCHEDULER parks
      // and retries, rather than an unbounded in-process queue nobody can see.
      if (!host) throw new HostUnavailableError();
      // Tier 2 is audited too when its host is not local: an OpenAI-compatible
      // provider row is configured exactly like a LAN LM Studio, and a public
      // one sends the customer's diffs off their network just as surely as
      // Tier-3 does.
      return withEgressAudit(
        host.baseUrl,
        2,
        host.modelSlot,
        prompt,
        opts.meta,
        () => t2.complete(prompt, { ...opts, maxTokens: T2_MAX_TOKENS }, host),
        (r) => ({ tokensSent: r.tokensIn, tokensReceived: r.tokensOut }),
      );
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
// Explicit, not a star: t3/client.ts already exports a `contentDigest` with the
// same meaning, and a star re-export here makes the package index ambiguous.
export {
  createEgressAuditor,
  isLocalHost,
  type AuditedAttempt,
  type EgressAttempt,
  type EgressAuditor,
  type EgressAuditRow,
  type EgressOutcome,
  type EgressWriter,
} from './egress-auditor.js';
export { T2Client, T2_DEFAULTS, T2_MAX_TOKENS } from '../t2/client.js';
export type { T2Config, T2Host } from '../t2/client.js';
