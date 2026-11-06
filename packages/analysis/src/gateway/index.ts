import {
  T2Client,
  T2_DEFAULTS,
  T2_MAX_TOKENS,
  ProviderError,
  type T2Config,
  type T2Deps,
  type T2Host,
} from '../t2/client.js';
import { runClaudeCli, type CliDeps } from '../providers/claude-cli.js';
import {
  LocalOnlyViolationError,
  defaultPool,
  hostIsLocal,
  hostOf,
  isOptionalRole,
  roleForDimension,
  type RouteRecord,
  type RoutingPolicy,
} from '../routing/index.js';
import { contentDigest, isLocalHost, type EgressAuditor } from './egress-auditor.js';
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
  /**
   * Per-role chains and the local-only switch (W19-02). Absent means the
   * behaviour from before this ticket: every call uses the shared host pool.
   */
  routing?: RoutingPolicy;
  /** Overrides for the customer-supplied CLI backend (tests; a non-default binary path). */
  cli?: CliDeps;
  /** Told which link served each call, for logs and provenance. */
  onRouted?: (route: RouteRecord) => void;
  /**
   * W20-21 (UX_TODO AI-63): told how each call to a host ended, so the caller
   * can record a connection's last success and last error from REAL calls
   * (no extra probe). Never given request content. Must not throw; a
   * rejection is ignored.
   */
  onHostResult?: (host: T2Host, result: { ok: true } | { ok: false; error: string }) => void;
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
  resolveAuditIds?: (meta: {
    repoId: string;
    initiator: string;
  }) => Promise<{ workspaceId: number; repoId: number; initiatorUserId?: number | null } | null>;
}

export class HostUnavailableError extends Error {
  constructor() {
    super('No Tier-2 host is available under the configured concurrency cap.');
    this.name = 'HostUnavailableError';
  }
}

export function createAnalysisGateway(deps: GatewayDeps): AnalysisGateway {
  const localOnly = deps.routing?.localOnly ?? false;
  // Under local-only the shared pool drops anything that would leave the
  // network; with it off this is deps.hosts unchanged.
  const pool = defaultPool(deps.hosts, localOnly);
  const config: T2Config = {
    ...T2_DEFAULTS,
    hosts: pool,
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
    meta: { repoId: string; initiator: string; role?: string | undefined; dimension?: string },
    send: () => Promise<T>,
    usageOf: (result: T) => { tokensSent: number | null; tokensReceived: number | null },
  ): Promise<T> {
    // W20-21 (UX_TODO AI-29): the role the call serves, on its audit rows.
    const role = meta.role ?? (meta.dimension ? roleForDimension(meta.dimension) : null) ?? null;
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
      role,
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

  /** One Tier-2 call to one host, audited when the host is not local. */
  async function callHost(
    host: T2Host,
    prompt: string,
    opts: CompleteOpts,
  ): Promise<CompleteResult> {
    try {
      const result = await callHostAudited(host, prompt, opts);
      report(host, { ok: true });
      return result;
    } catch (err) {
      report(host, { ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** W20-21 (AI-63): the caller's record of how a call ended; never allowed to fail one. */
  function report(host: T2Host, result: { ok: true } | { ok: false; error: string }): void {
    try {
      deps.onHostResult?.(host, result);
    } catch {
      // A bookkeeping failure must not turn a good answer into an error.
    }
  }

  function callHostAudited(
    host: T2Host,
    prompt: string,
    opts: CompleteOpts,
  ): Promise<CompleteResult> {
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
      () =>
        host.transport === 'claude_cli'
          ? // The customer's own CLI, counted against the same concurrency cap. It
            // is audited above like any host that leaves the network: its nominal
            // destination is Anthropic.
            t2.track(host, async () => {
              const r = await runClaudeCli(prompt, host.modelSlot, deps.cli, opts.promptParts);
              return {
                text: r.text,
                model: r.model,
                tokensIn: r.tokensIn,
                tokensOut: r.tokensOut,
                cacheReadTokens: r.cacheReadTokens,
                // The plan is flat-rate: a per-call dollar figure would be invented.
                costUsd: null,
                durationMs: r.durationMs,
              };
            })
          : t2.complete(prompt, { ...opts, maxTokens: T2_MAX_TOKENS }, host),
      (r) => ({ tokensSent: r.tokensIn, tokensReceived: r.tokensOut }),
    );
  }

  function recordOf(
    role: RouteRecord['role'],
    host: T2Host,
    linkIndex: number,
    failedLinks: RouteRecord['failedLinks'],
    providerName?: string,
  ): RouteRecord {
    return {
      role,
      providerId: host.providerId ?? null,
      providerName: providerName ?? host.name ?? host.baseUrl,
      model: host.modelSlot,
      linkIndex,
      failedLinks,
    };
  }

  return {
    async complete(prompt, opts) {
      if (opts.tier === 'T3' && localOnly) {
        // Tier-3 always leaves the network. Refused like a missing opt-in, and
        // recorded the same way, so the audit shows the attempt.
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
              role: opts.meta.role ?? roleForDimension(opts.meta.dimension),
            },
            'Local-only is on for this workspace; Tier-3 would leave the network.',
          );
        }
        throw new LocalOnlyViolationError(
          opts.meta.role ?? roleForDimension(opts.meta.dimension),
          'Tier-3 (Claude API)',
        );
      }

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
                role: opts.meta.role ?? roleForDimension(opts.meta.dimension),
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

      const role = opts.meta.role ?? roleForDimension(opts.meta.dimension);
      const chain = role ? deps.routing?.chains[role] : undefined;

      // W22-03: an optional role (triage_fast) is only ever its own chain.
      if (chain === undefined && isOptionalRole(role)) {
        throw new Error(
          `Role "${role}" is optional and not routed, so nothing was sent. Route it in Settings → Models → Routing.`,
        );
      }

      // No chain for this role: the shared pool, exactly as before W19-02.
      if (chain === undefined) {
        // W25-02: a host at its cap is WAITED for (host-slots.ts, bounded by
        // queueTimeoutMs and failing as HostBusyError by name), not refused.
        // Refusing meant a second repository's judge failed five times in
        // 16 ms and anti-slop skipped its AI review whenever another call of
        // the same client held a one-slot local model (0.2.0 install, A1/P9);
        // nothing ever parked and retried. Null now means an empty pool only.
        const host = t2.pickHost() ?? t2.leastLoadedHost();
        if (!host) throw new HostUnavailableError();
        const result = await callHost(host, prompt, opts);
        const route = recordOf(role, host, deps.hosts.indexOf(host), []);
        deps.onRouted?.(route);
        return { ...result, route };
      }

      // A role that IS routed but has no usable connection (all disabled or
      // deleted) refuses by name instead of quietly using the shared pool and a
      // model nobody chose for it.
      if (chain.length === 0) {
        throw new Error(
          `Role "${role}" is routed to specific connections but none of them is usable (disabled, deleted or misconfigured) — fix it in Settings → Models → Routing.`,
        );
      }

      // A chain. Each link is tried in order; only a PROVIDER error moves on.
      // W25-02: links with a free slot first, in chain order; then the busy
      // ones, in chain order, where the call waits for the slot instead of the
      // whole chain failing with "No Tier-2 host is available".
      const failed: RouteRecord['failedLinks'] = [];
      for (const link of chain) {
        // Defence in depth: the chain was valid when it was saved, but a
        // connection can be edited afterwards.
        if (localOnly && !hostIsLocal(link.host)) {
          throw new LocalOnlyViolationError(role, link.providerName, hostOf(link.host));
        }
      }
      const free = chain.map((_, i) => i).filter((i) => t2.hasCapacity(chain[i]!.host));
      const busy = chain.map((_, i) => i).filter((i) => !free.includes(i));
      for (const i of [...free, ...busy]) {
        const link = chain[i]!;
        try {
          const result = await callHost(link.host, prompt, opts);
          const route = recordOf(role, link.host, i, failed, link.providerName);
          deps.onRouted?.(route);
          return { ...result, route };
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err; // a bad answer is not a reason to switch models
          failed.push({
            providerName: link.providerName,
            model: link.host.modelSlot,
            error: err.message,
          });
        }
      }
      throw new Error(
        `Every connection for role "${role}" failed: ` +
          failed.map((f) => `${f.providerName} (${f.error})`).join('; '),
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
export {
  T2Client,
  T2_DEFAULTS,
  T2_MAX_TOKENS,
  ProviderError,
  chatCompletionsUrl,
} from '../t2/client.js';
export type { T2Config, T2Host } from '../t2/client.js';
// W25-02: a call that waited its whole queue timeout for a busy host fails by
// this name, so callers that skip on a busy model can recognise it.
export { HostBusyError, HostSlots } from '../t2/host-slots.js';
