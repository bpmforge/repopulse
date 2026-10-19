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
  // W16-59. Removing a member is the most destructive thing an admin can do
  // from the UI: it ends a person's access and takes their saved views with it,
  // while deliberately LEAVING their reports, plans, agreements and triage
  // history behind. The target's login is recorded because after the delete
  // there is no row to resolve the id against — the audit entry is the only
  // place the name survives.
  | 'admin.member.removed'
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
  | 'scanner.enablement_changed'
  // W9-07. A rule going live changes what EVERY future scan says about
  // someone's code — it is closer to a settings change than to a finding — so
  // each lifecycle step carries who made it. The shadow→active step matters
  // most: that is the moment a rule starts moving health scores.
  // W8-14. A VEX statement STOPS A VULNERABILITY BEING REPORTED, which makes
  // it the most consequential thing anyone can do on a security screen: the
  // finding does not move to a quieter list, it stops being created. Who
  // decided that, about which versions, and on what justification is the
  // record the whole suppression design rests on — and withdrawing one is
  // equally auditable, because it changes what future scans say.
  //
  // OUT OF W8-14'S DECLARED WRITE SCOPE and added anyway: the union is closed,
  // so a route cannot log a new audit event without a member here. Declared in
  // the handoff.
  | 'vex.statement_recorded'
  | 'vex.statement_withdrawn'
  | 'rule.proposed'
  | 'rule.candidate'
  | 'rule.active'
  | 'rule.deprecated'
  // W16-07. A provider row decides WHERE THIS WORKSPACE'S DIFFS ARE SENT — the
  // same class of decision as a Tier-3 opt-in, and the reason both are
  // admin-only. Adding one that names a public endpoint is a data-egress
  // decision with an author, not a settings preference; deleting one silently
  // stops analysis, which is equally worth a record.
  | 'llm_provider.created'
  | 'llm_provider.deleted'
  // W20-06 (UX_TODO AI-03). Editing or switching off a connection changes where
  // diffs go just as creating one does. The key itself is never in the detail.
  | 'llm_provider.updated'
  | 'llm_routing.updated'
  // W19-08. Accepting or revoking the responsibility statement for the
  // customer-supplied Claude Code CLI: who, when, which version.
  | 'llm_claude_cli.accepted'
  | 'llm_claude_cli.revoked'
  // W19-09. An admin started an AI pass, and a person answered an AI suggestion.
  | 'ai_pass.started'
  | 'ai_verdict.decided'
  // W19-12. Scheduled AI passes are strictly opt-in: who enabled one (and which
  // destinations they acknowledged), who turned it off, what a schedule started, and
  // what it refused to start and why.
  | 'ai_pass_schedule.enabled'
  | 'ai_pass_schedule.disabled'
  | 'ai_pass_schedule.updated'
  | 'ai_pass.scheduled_started'
  | 'ai_pass.scheduled_skipped'
  | 'ai_pass_settings.updated'
  // W16-10. A manual run spends CPU on the host and, for a sync, forge budget
  // that everything else has to share. Who asked for it is the same record a
  // scheduled pass gets from its cron line.
  | 'scan.manual_run'
  | 'sync.manual_run'
  // W18-18. A CI token is a credential that reads findings from outside the
  // product, unattended, for as long as it lives — the same class of record as
  // a forge connection being created or deleted. Who minted it, for which
  // repositories, and who revoked it is the whole of its paper trail.
  | 'ci_token.created'
  | 'ci_token.revoked'
  // W18-19. Drafting a verified patch sends a file of the customer's source to
  // a model — the workspace's own by default, a third party's at Tier-3 — and
  // spends model time. Who asked, for which finding, at which tier.
  | 'patch.draft_requested'
  // W18-24. An uploaded SARIF file writes findings — and can CLOSE findings
  // its tool no longer reports — on someone's say-so rather than a scan we ran.
  // Who uploaded what, for which repository, is the provenance a reader of
  // those findings needs. (Outside W18-24's write scope; the union is closed.)
  | 'external_findings.sarif_uploaded'
  // W20-07 (UX_TODO INS-03, INS-08, INS-09).
  | 'auth.password_reset'
  | 'connection.credential_replaced'
  | 'connection.removed'
  | 'repo.tracking_paused'
  | 'repo.tracking_resumed'
  // W20-10 (UX_TODO INS-51, ADM-77). Linking a person to a forge account
  // decides whose commits and reviews My Focus counts as theirs; re-pointing
  // every webhook is a change to where the forge sends deliveries.
  | 'identity.linked'
  | 'connection.webhooks_reregistered'
  // W20-10 (UX_TODO ADM-13). Written by deploy/backup.sh straight into
  // audit_events (it has psql, not this function); listed so the name is
  // owned here. System health reads the newest one as "last backup".
  | 'ops.backup.taken';

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

/** One audit entry as handed to a sink: the entry plus the time it was logged. */
export type AuditRecord = AuditEntry & { ts: string };

/**
 * Where audit entries go besides the log (W20-10, UX_TODO X-04).
 *
 * The API and worker register one at boot that writes the
 * `audit_events` table behind Settings → Audit log. A process-wide hook rather
 * than a new parameter because every one of the ~60 call sites already passes
 * `request.log`, and threading a database handle through each of them is how
 * one gets missed. A sink must not throw; persistence failures are its own to
 * report, and the log line above has already been written either way.
 */
export type AuditSink = (record: AuditRecord) => void;

let auditSink: AuditSink | undefined;

/** Install (or with undefined, remove) the process-wide audit sink. */
export function setAuditSink(sink: AuditSink | undefined): void {
  auditSink = sink;
}

export function auditLog(logger: AuditLogger, entry: AuditEntry): void {
  const ts = new Date().toISOString();
  logger.info({ audit: true, ...entry, ts }, `audit:${entry.event}`);
  if (!auditSink) return;
  try {
    auditSink({ ...entry, ts });
  } catch (err) {
    // The action being audited already happened; a broken sink must not turn
    // it into a 500. The log line above is still the record.
    logger.info({ err, auditEvent: entry.event }, 'audit sink failed');
  }
}
