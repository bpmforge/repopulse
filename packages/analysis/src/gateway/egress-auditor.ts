import { createHash, randomUUID } from 'node:crypto';

// The egress auditor (W17-11).
//
// WHAT WAS WRONG. `egress_audit` had a reader (Admin → Analysis) and NO
// PRODUCTION WRITER: the only thing that ever built a client capable of writing
// one was `createT3Client`, and the only caller of that was its own test. So the
// screen reporting "what has left this network" was reporting an empty table on
// an install that had been sending diffs to a configured cloud provider all
// along — because a Tier-2 provider row may name a PUBLIC host, and that path
// was never considered egress.
//
// TWO ROWS PER ATTEMPT. SC-15 grants the app role INSERT and SELECT only, so an
// outcome cannot be an UPDATE — the database would refuse it, which is the
// protection doing its job. Instead an attempt writes:
//
//   1. `attempted`  BEFORE the request is dispatched
//   2. `succeeded` | `failed` | `denied`  afterwards
//
// sharing one `attempt_id`. If the process dies between them, the surviving
// `attempted` row is the truth: the bytes left and we do not know what came
// back. A single row written after the fact could not say that.
//
// FAIL CLOSED. If the pre-flight audit write fails, the request is NOT sent. An
// un-auditable egress is worse than a failed analysis, and this is the one place
// that ordering is enforceable.

/** What the caller is about to send. Never the content itself. */
export interface EgressAttempt {
  workspaceId: number;
  repoId: number;
  /** 2 or 3. */
  tier: number;
  modelId: string;
  /** Host the bytes are addressed to — the whole question, in one field. */
  destinationHost: string;
  /** Byte length of the payload. Known before dispatch, always. */
  bytesSent: number;
  /** sha256 of exactly what is being sent. Proof of content without content. */
  contentSha256: string;
  analysisRunId?: number | null;
  pullRequestId?: number | null;
  initiatorUserId?: number | null;
  initiatorLogin?: string | null;
}

export interface EgressOutcome {
  /** NULL when the provider did not report usage. NEVER 0 as a stand-in. */
  tokensSent?: number | null;
  tokensReceived?: number | null;
  error?: string | null;
}

export interface EgressAuditRow extends EgressAttempt {
  attemptId: string;
  outcome: 'attempted' | 'succeeded' | 'failed' | 'denied';
  tokensSent: number | null;
  tokensReceived: number | null;
  error: string | null;
}

/** Persists one audit row. Rejects if it cannot. */
export type EgressWriter = (row: EgressAuditRow) => Promise<void>;

export interface AuditedAttempt {
  attemptId: string;
  /** Record the outcome. Called exactly once per attempt. */
  settle: (outcome: 'succeeded' | 'failed' | 'denied', detail?: EgressOutcome) => Promise<void>;
}

export function contentDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Hosts that never leave the operator's own network.
 *
 * A LAN LM Studio is not egress, and auditing it would bury the rows that
 * matter under thousands that do not. Anything not matching this is treated as
 * off-network — the safe direction to be wrong in.
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }

  // The private-range checks apply ONLY to something that is actually an IPv4
  // address. A prefix test alone treats `10.evil.com` as private — a public
  // host that would then have been exempted from auditing altogether, which is
  // a hole rather than a cosmetic bug. Caught by its own test.
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return false;

  // RFC1918 + loopback.
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export interface EgressAuditorDeps {
  write: EgressWriter;
  /** Test seam. */
  newAttemptId?: () => string;
}

export interface EgressAuditor {
  /**
   * Record the attempt BEFORE dispatch.
   *
   * @throws if the audit cannot be persisted — the caller must then NOT send.
   */
  begin: (attempt: EgressAttempt) => Promise<AuditedAttempt>;
  /**
   * Record a request that policy refused. Nothing was sent, so bytesSent is 0,
   * but a blocked attempt is exactly what an auditor wants to see.
   */
  denied: (attempt: Omit<EgressAttempt, 'bytesSent'>, reason: string) => Promise<void>;
}

export function createEgressAuditor(deps: EgressAuditorDeps): EgressAuditor {
  const newId = deps.newAttemptId ?? (() => randomUUID());

  return {
    async begin(attempt) {
      const attemptId = newId();

      // BEFORE dispatch, and deliberately not caught: a rejection here must
      // propagate so the caller does not send. Swallowing it would produce
      // exactly the silent un-audited egress this module exists to prevent.
      await deps.write({
        ...attempt,
        attemptId,
        outcome: 'attempted',
        tokensSent: null,
        tokensReceived: null,
        error: null,
      });

      let settled = false;
      return {
        attemptId,
        async settle(outcome, detail) {
          // One outcome per attempt. A second call would double-count the
          // egress, which is the number this table exists to get right.
          if (settled) return;
          settled = true;
          await deps.write({
            ...attempt,
            attemptId,
            outcome,
            // Unknown stays unknown. Recording 0 would assert a measurement
            // nobody made.
            tokensSent: detail?.tokensSent ?? null,
            tokensReceived: detail?.tokensReceived ?? null,
            error: detail?.error ?? null,
          });
        },
      };
    },

    async denied(attempt, reason) {
      await deps.write({
        ...attempt,
        bytesSent: 0,
        attemptId: newId(),
        outcome: 'denied',
        tokensSent: null,
        tokensReceived: null,
        error: reason,
      });
    },
  };
}
