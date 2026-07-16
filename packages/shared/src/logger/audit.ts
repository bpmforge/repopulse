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

// SC-22 event classes wired so far (login/logout - the only real routes
// that exist). Later waves add: connection.created/updated/deleted,
// tier3.opt_in.toggled, share.created/revoked, report.downloaded,
// finding.bulk_export, identity.merged, role.changed (docs/SECURITY_CONTROLS.md
// SC-22) - each new event class is additive, this union grows per wave.
export type AuditEvent =
  'auth.login.success' | 'auth.login.failure' | 'auth.logout' | 'auth.session.revoked';

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
