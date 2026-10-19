import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, setAuditSink, type AuditRecord } from '@repopulse/shared';
import { auditRow } from './audit-store.js';

// W20-10 (UX_TODO X-04): auditLog also feeds a persisted sink.
describe('auditRow', () => {
  it('splits the envelope into columns and keeps the rest as detail', () => {
    const row = auditRow({
      event: 'admin.role.changed',
      actorUserId: 3,
      workspaceId: 9,
      ip: '10.0.0.1',
      ua: 'ua',
      ts: '2026-10-19T00:00:00.000Z',
      targetUserId: 4,
      toRole: 'admin',
      skipped: undefined,
    } as AuditRecord);
    expect(row).toEqual({
      workspaceId: 9,
      event: 'admin.role.changed',
      actorUserId: 3,
      ip: '10.0.0.1',
      ua: 'ua',
      detail: { targetUserId: 4, toRole: 'admin' },
      occurredAt: new Date('2026-10-19T00:00:00.000Z'),
    });
  });

  it('drops an entry with no workspace (it stays in the log only)', () => {
    expect(
      auditRow({ event: 'auth.login.failure', actorUserId: null, ts: 'x' } as AuditRecord),
    ).toBeNull();
  });
});

describe('the audit sink', () => {
  afterEach(() => setAuditSink(undefined));

  it('receives every entry, and a failing sink never fails the action', () => {
    const seen: AuditRecord[] = [];
    const lines: string[] = [];
    const logger = { info: (_o: Record<string, unknown>, msg: string) => lines.push(msg) };
    setAuditSink((r) => seen.push(r));
    auditLog(logger, { event: 'admin.role.changed', actorUserId: 1, workspaceId: 2 } as never);
    expect(seen[0]).toMatchObject({ event: 'admin.role.changed', workspaceId: 2 });
    expect(typeof seen[0]!.ts).toBe('string');

    setAuditSink(() => {
      throw new Error('db down');
    });
    expect(() =>
      auditLog(logger, { event: 'admin.role.changed', actorUserId: 1, workspaceId: 2 } as never),
    ).not.toThrow();
    expect(lines).toContain('audit sink failed');
  });
});
