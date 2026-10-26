import type { T2Host } from '../t2/client.js';
import type { Dimension } from '../gateway/types.js';
import { hostIsLocal } from '../routing/index.js';
import type { VerdictInput, VerifyStatus } from './verify.js';

// The second-model verify, as callers use it (W21-03, FR-ANALYSIS-9, D9).
//
// passes/verify.ts has had the rule since W6-05 — the model that judges a
// finding must not be the one that raised it — and the prompt, and nothing in
// production called either. These are the pieces every production caller
// shares: what a verify request carries, how the verifier's connection is
// chosen, and how its answer is read. The caller (the worker) owns the
// database facts the choice depends on: the repository's Tier-3 opt-in, the
// workspace's local-only switch and AI switch, and the monthly call cap.

/** What a caller hands the verifier about one finding. */
export interface VerifyRequest {
  title: string;
  evidenceQuote: string;
  file: string;
  severity: number;
  dimension: string;
  rationale: string;
  /** The code the finding is about, as the finder saw it. */
  excerpt: string;
  /** Who raised it, so the verifier is someone else. Null fields = unknown. */
  finder: { providerId: number | null; model: string | null };
}

/** A second opinion that was had. */
export interface VerifyOutcome {
  refuted: boolean;
  reason: string;
  /** Which model and connection answered. Absent only in older stubs. */
  verifier?: { model: string; providerId: number | null; connection: string | null };
}

/** No second opinion, and why, in words a person reads on the finding. */
export interface VerifyRefusal {
  unverified: true;
  reason: string;
}

export type SecondModelVerify = (req: VerifyRequest) => Promise<VerifyOutcome | VerifyRefusal>;

export function isRefusal(v: VerifyOutcome | VerifyRefusal): v is VerifyRefusal {
  return (v as VerifyRefusal).unverified === true;
}

/** What a stored finding records from a verify call. */
export interface FindingVerdict {
  status: VerifyStatus;
  model: string | null;
  providerId: number | null;
  connection: string | null;
  reason: string | null;
}

/**
 * The verdict a finding stores. A refutation MARKS the finding `contradicted`;
 * it never changes its status, so nothing is dismissed by a model.
 */
export function findingVerdict(v: VerifyOutcome | VerifyRefusal): FindingVerdict {
  if (isRefusal(v)) {
    return {
      status: 'unverified',
      model: null,
      providerId: null,
      connection: null,
      reason: v.reason,
    };
  }
  return {
    status: v.refuted ? 'contradicted' : 'confirmed',
    model: v.verifier?.model ?? null,
    providerId: v.verifier?.providerId ?? null,
    connection: v.verifier?.connection ?? null,
    reason: v.reason.slice(0, 1000),
  };
}

/** Whether a connection would send code off the network. */
export function leavesNetwork(host: T2Host): boolean {
  return host.transport === 'claude_cli' || !hostIsLocal(host);
}

export const NO_INDEPENDENT_HOST =
  'No second AI connection on a different host is configured, so no other model could check this. ' +
  'A model asked whether it was right agrees with itself, so it was not asked.';

export const OFF_NETWORK_NOT_ALLOWED =
  'The only other AI connection is off your network, and this repository is not opted in to Tier 3 ' +
  '(or local-only is on), so the second opinion was not asked for.';

export const FINDER_UNKNOWN =
  'Which model raised this is not recorded, so a different one could not be picked to check it.';

/**
 * Picks the verifier's connection: a configured connection (one that can be
 * pinned), not the finder's, on a different host from the finder's, and on the
 * network unless the caller says off-network is allowed (Tier-3 opt-in and
 * local-only off). Local connections first.
 *
 * `finder` null means there is no model maker (a rule or a tool raised it, as
 * with a dependency CVE): any eligible connection will do.
 */
export function chooseVerifierHost(
  hosts: readonly T2Host[],
  finder: { providerId: number | null; model: string | null } | null,
  opts: {
    offNetworkAllowed: boolean;
    /** The caller's own rule for "leaves the network", when it has one (the API's describeEndpoint). */
    leavesNetwork?: (host: T2Host) => boolean;
  },
): { host: T2Host } | { refused: string } {
  const offNetwork = opts.leavesNetwork ?? leavesNetwork;
  const pinnable = hosts.filter((h) => typeof h.providerId === 'number');
  let independent = pinnable;
  if (finder) {
    const finderHost =
      finder.providerId === null
        ? undefined
        : hosts.find((h) => h.providerId === finder.providerId);
    if (!finderHost) return { refused: FINDER_UNKNOWN };
    independent = pinnable.filter(
      (h) => h.providerId !== finderHost.providerId && h.baseUrl !== finderHost.baseUrl,
    );
  }
  if (independent.length === 0) return { refused: NO_INDEPENDENT_HOST };
  const local = independent.filter((h) => !offNetwork(h));
  if (local.length > 0) return { host: local[0]! };
  if (!opts.offNetworkAllowed) return { refused: OFF_NETWORK_NOT_ALLOWED };
  return { host: independent[0]! };
}

/** The gateway dimension a verify call is filed under, from the finding's. */
export function verifyDimension(dimension: string): Dimension {
  switch (dimension) {
    case 'security':
    case 'dependency':
      return 'security';
    case 'performance':
      return 'performance';
    case 'test_coverage':
      return 'test_coverage';
    case 'best_practices':
      return 'best_practices';
    case 'slop':
    case 'ai_slop':
      return 'ai_slop';
    default:
      return 'code_health';
  }
}

/**
 * Reads `{"refuted": bool, "reason": string}`, fenced or not. Null for anything
 * else: an answer that cannot be read leaves the finding unverified, never
 * confirmed.
 */
export function parseVerifyAnswer(text: string): VerdictInput | null {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  let raw: unknown;
  try {
    raw = JSON.parse(fenced?.[1] ?? text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { refuted?: unknown; reason?: unknown };
  if (typeof r.refuted !== 'boolean') return null;
  return { refuted: r.refuted, reason: typeof r.reason === 'string' ? r.reason.slice(0, 400) : '' };
}

/**
 * A few lines of `text` around the first line containing `quote` (or the
 * given line), so the verifier reads the code at issue and not a whole file.
 */
export function excerptAround(
  text: string,
  at: { quote?: string; line?: number },
  radius = 20,
): string {
  const lines = text.split('\n');
  let index = -1;
  const needle = at.quote?.trim();
  if (needle) index = lines.findIndex((l) => l.includes(needle));
  if (index === -1 && at.line !== undefined) index = Math.max(0, at.line - 1);
  if (index === -1) index = 0;
  return lines.slice(Math.max(0, index - radius), index + radius + 1).join('\n');
}
