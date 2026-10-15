import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, security, type Database } from '@repopulse/shared';
import { parseOpengrepOutput } from '../scanners/semgrep/output.js';
import { toIncomingFindings } from '../scanners/semgrep/scanner.js';
import {
  applyShadow,
  effectiveStatus,
  registryStatuses,
  shippedStatusOf,
  type ShippedStatus,
} from './shadow.js';

// Shadow mode for pack rules (W18-13, CODE_HEALTH_SUITE.md §8.2).

const finding = (ruleId: string, shippedStatus: ShippedStatus) => ({ ruleId, shippedStatus });

describe('a rule file marks a new rule as a candidate', () => {
  it('reads metadata.lifecycle, and treats everything else as live', () => {
    expect(shippedStatusOf({ lifecycle: 'candidate' })).toBe('candidate');
    // Rules that predate the lifecycle line keep doing what they did.
    expect(shippedStatusOf({})).toBe('active');
    expect(shippedStatusOf({ lifecycle: 'active' })).toBe('active');
    expect(shippedStatusOf({ lifecycle: 'whatever' })).toBe('active');
  });

  it('carries the line from opengrep output into the finding', () => {
    const result = (id: string, metadata: Record<string, unknown>) => ({
      check_id: `rules.pack.${id}`,
      path: '/scan/src/A.java',
      start: { line: 3 },
      end: { line: 3 },
      extra: { message: 'm', severity: 'WARNING', metadata },
    });
    const parsed = parseOpengrepOutput({
      stdout: JSON.stringify({
        results: [result('bpm-new', { lifecycle: 'candidate' }), result('bpm-old', {})],
        errors: [],
      }),
      knownRuleIds: ['bpm-new', 'bpm-old'],
      rootDir: '/scan',
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.findings.map((f) => [f.ruleId, f.shippedStatus])).toEqual([
      ['bpm-new', 'candidate'],
      ['bpm-old', 'active'],
    ]);
  });
});

describe('the registry row always wins over the shipped default', () => {
  it('resolves each combination', () => {
    expect(effectiveStatus('candidate', undefined)).toBe('candidate');
    expect(effectiveStatus('active', undefined)).toBe('active');
    expect(effectiveStatus('candidate', 'active')).toBe('active');
    expect(effectiveStatus('active', 'deprecated')).toBe('deprecated');
    // A row under evaluation runs in shadow: evaluating needs findings.
    expect(effectiveStatus('active', 'proposed')).toBe('candidate');
    expect(effectiveStatus('candidate', 'candidate')).toBe('candidate');
  });

  it('stamps candidates experimental, drops deprecated, leaves untouched rules unstated', () => {
    const registry = new Map([
      ['bpm-promoted', 'active' as const],
      ['bpm-retired', 'deprecated' as const],
    ]);
    const out = applyShadow(
      [
        finding('bpm-new', 'candidate'),
        finding('bpm-promoted', 'candidate'),
        finding('bpm-retired', 'active'),
        finding('bpm-old', 'active'),
      ],
      registry,
    );
    expect(out).toEqual([
      { ruleId: 'bpm-new', shippedStatus: 'candidate', experimental: true },
      { ruleId: 'bpm-promoted', shippedStatus: 'candidate', experimental: false },
      // No `experimental` key at all: the store reads absent as "keep the
      // row's flag", which is what a rule with no lifecycle opinion means.
      { ruleId: 'bpm-old', shippedStatus: 'active' },
    ]);
    expect('experimental' in out[2]!).toBe(false);
  });

  it('reaches the stored finding shape', () => {
    const base = {
      file: 'src/A.java',
      lineStart: 1,
      lineEnd: 1,
      severity: 3,
      title: 'bpm-new',
      message: 'm',
      yields: [],
      cwe: null,
    };
    const [shadowed, live] = toIncomingFindings([
      { ...base, ruleId: 'bpm-new', shippedStatus: 'candidate', experimental: true },
      { ...base, ruleId: 'bpm-old', shippedStatus: 'active' },
    ]);
    expect(shadowed?.experimental).toBe(true);
    expect(live && 'experimental' in live).toBe(false);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('registry statuses are read per workspace (W18-13)', () => {
  const db: Database = createDb(databaseUrl as string);
  const ids = ['bpm-w18-13-shadow-a', 'bpm-w18-13-shadow-b'];
  let workspaceId = 0;
  let otherWorkspaceId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [other] = await db
      .insert(core.workspaces)
      .values({ slug: 'w18-13-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    otherWorkspaceId = other!.id;
    const provenance = {
      source: 'ours',
      license: 'UNLICENSED',
      author: 'test',
      date: '2026-10-15',
    };
    await db.delete(security.ruleRegistry).where(inArray(security.ruleRegistry.ruleId, ids));
    await db.insert(security.ruleRegistry).values([
      { workspaceId, ruleId: ids[0]!, status: 'active', provenance },
      // Deprecated in ANOTHER workspace: must not leak into this one.
      { workspaceId: otherWorkspaceId, ruleId: ids[1]!, status: 'deprecated', provenance },
    ]);
  });

  afterAll(async () => {
    await db.delete(security.ruleRegistry).where(inArray(security.ruleRegistry.ruleId, ids));
    await db
      .delete(core.workspaces)
      .where(
        and(eq(core.workspaces.id, otherWorkspaceId), eq(core.workspaces.slug, 'w18-13-other')),
      );
  });

  it('returns only this workspace’s rows, in one query', async () => {
    const mine = await registryStatuses(db, workspaceId, [...ids, ids[0]!]);
    expect([...mine.entries()]).toEqual([[ids[0], 'active']]);
    const theirs = await registryStatuses(db, otherWorkspaceId, ids);
    expect([...theirs.entries()]).toEqual([[ids[1], 'deprecated']]);
    expect((await registryStatuses(db, workspaceId, [])).size).toBe(0);
  });
});
