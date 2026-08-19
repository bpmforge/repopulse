// Minimal structural logger type (not pino's own `Logger`) - Fastify's
// `request.log` is typed `FastifyBaseLogger`, which is intentionally NOT
// identical to pino's `Logger` (Fastify's `loggerInstance` option accepts
// any object conforming to a subset of the pino interface, per its own
// docs), so requiring the full pino `Logger` type here would reject a real
// `request.log` at the type level even though it works correctly at
// runtime (verified: pino child loggers, which `request.log` is one of,
// inherit the parent's `streamWrite` redaction hook).
export interface AuditLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

// SC-22 event classes wired so far. Later waves add: connection.created/
// updated/deleted, tier3.opt_in.toggled, share.created/revoked,
// report.downloaded, finding.bulk_export, identity.merged
// (docs/SECURITY_CONTROLS.md SC-22) - each new event class is additive, this
// union grows per wave.
export type AuditEvent =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.session.revoked'
  // W4-09. Workspace settings decide what every metric counts (bot list,
  // stale-N) and how the health score is weighted, so a changed number can
  // move every screen at once with nothing else in the system to show why.
  | 'workspace.settings.updated'
  // W12-09. SC-22 names "admin role change" in its own list of audited event
  // classes, and W4-20 shipped the route without it - the control was
  // specified, the endpoint existed, the log line was never written. T-29
  // (any member can bulk-read the org vuln map) and T-31 (untraceable share)
  // both lean on this stream to answer "who granted that access, and when".
  | 'admin.role.changed'
  // NOT on the SC-22 list. Replaying a dead-lettered job re-runs work against
  // the forge on an operator's say-so, which is a privileged mutation with no
  // other record: the job_failure row gets a replayed_at stamp and nothing
  // says who pressed it. Logged deliberately rather than left out because the
  // list did not happen to anticipate it.
  | 'dlq.job.replayed'
  // W5-05. SC-22 names "identity merge" in its own list. A merge rewrites who
  // authored what on every ownership and bus-factor screen, so an unattributed
  // one is a silent change to the numbers people make staffing decisions on.
  | 'identity.merged'
  | 'identity.merge_undone'
  | 'identity.bot_flagged'
  // W5-04. SC-22 names report download explicitly: a report carries an
  // organisation's delivery data, so who took a copy and when is the record
  // T-31 asks for.
  | 'report.generated'
  | 'report.downloaded'
  // W5-06. A plan item moving is a decision about a team's work; the nightly
  // verifier's transitions are audited too, with a null actor.
  | 'plan.generated'
  | 'plan.item.transitioned'
  // W5-08. An agreement threshold decides what counts as a breach on every
  // screen that reads it, so a change to one is a change to the numbers.
  | 'agreement.configured'
  // W5-09. A schedule generates reports unattended from then on, so who set
  // one and at what cadence is part of the record.
  | 'report.scheduled'
  // W6-04. A finding is a claim about someone's code; who dismissed it and why
  // is the record that makes the claim reviewable later (FR-INSIGHTS-1).
  | 'finding.status_changed'
  // W6-07. Acknowledging a file hides it from hotspot leaderboards, so who
  // decided that and when is part of the record.
  | 'file.intent_set'
  // W7-08. Turning Tier-3 on means this repository's diffs may leave the
  // network. Who decided that, and when, is not a preference — it is the
  // record NFR-9 depends on.
  | 'repo.tier3_opt_in_changed'
  // W8-01. Turning a scanner off is a decision about what this workspace stops
  // looking for, which is exactly the kind of change an audit exists for.
  | 'scanner.enablement_changed';

export interface AuditEntry {
  event: AuditEvent;
  /** null when the actor is unknown (e.g. a login failure before identity resolution). */
  actorUserId: number | null;
  workspaceId: number | null;
  ip: string;
  ua: string | null;
  /** Event-specific detail, e.g. a login-failure reason. Never token/credential material. */
  [extra: string]: unknown;
}

export function auditLog(logger: AuditLogger, entry: AuditEntry): void {
  logger.info({ audit: true, ...entry, ts: new Date().toISOString() }, `audit:${entry.event}`);
}
