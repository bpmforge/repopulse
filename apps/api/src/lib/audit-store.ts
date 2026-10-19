import { sql } from 'drizzle-orm';
import {
  core,
  read,
  setAuditSink,
  type AuditRecord,
  type AuditSink,
  type Database,
} from '@repopulse/shared';

// The persisted half of auditLog (W20-10, UX_TODO X-04). Every audit event was
// a log line only, so Settings could not answer "who changed this, and when".
// This sink writes each workspace-scoped entry to `audit_events`.
//
// Fire-and-forget on purpose: the action being audited has already happened
// and its response must not wait on, or fail because of, the audit write. A
// failed write is reported through `onError` (the app logger) and the log line
// auditLog wrote first is still the record.

/** The envelope fields; everything else on an entry is its event detail. */
const ENVELOPE = new Set(['event', 'actorUserId', 'workspaceId', 'ip', 'ua', 'ts']);

/** Splits an entry into the columns and the event-specific detail. */
export function auditRow(record: AuditRecord): typeof read.auditEvents.$inferInsert | null {
  // No workspace = no tenant to show it to (a failed sign-in before anyone is
  // known). It stays in the log only.
  if (typeof record.workspaceId !== 'number') return null;
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!ENVELOPE.has(key) && value !== undefined) detail[key] = value;
  }
  return {
    workspaceId: record.workspaceId,
    event: record.event,
    actorUserId: record.actorUserId,
    ip: record.ip || null,
    ua: record.ua,
    detail,
    occurredAt: new Date(record.ts),
  };
}

export interface AuditStore {
  sink: AuditSink;
  /** Resolves once every write started so far has settled (tests, shutdown). */
  flush: () => Promise<void>;
}

export function createAuditStore(db: Database, onError: (err: unknown) => void): AuditStore {
  const pending = new Set<Promise<void>>();
  const sink: AuditSink = (record) => {
    const row = auditRow(record);
    if (!row) return;
    const write = db
      .insert(read.auditEvents)
      .values({
        ...row,
        // The login as it is NOW, beside the id: a removed member's user row is
        // deleted, and this column is where their name survives.
        actorLogin:
          row.actorUserId == null
            ? null
            : sql`(select ${core.users.login} from ${core.users} where ${core.users.id} = ${row.actorUserId})`,
      })
      .then(
        () => undefined,
        (err: unknown) => onError(err),
      );
    pending.add(write);
    void write.finally(() => pending.delete(write));
  };
  return {
    sink,
    flush: async () => {
      await Promise.all([...pending]);
    },
  };
}

let installed: AuditStore | undefined;

/**
 * Makes this database the process's audit sink. Called by buildApp and the
 * worker entrypoint, so production and every test app persist the same way —
 * an opt-in a caller could forget is how the log-only gap would come back.
 */
export function installAuditStore(db: Database, onError: (err: unknown) => void): AuditStore {
  installed = createAuditStore(db, onError);
  setAuditSink(installed.sink);
  return installed;
}

/** Waits for the audit writes in flight (a test asserting on audit_events). */
export function flushAuditWrites(): Promise<void> {
  return installed?.flush() ?? Promise.resolve();
}
