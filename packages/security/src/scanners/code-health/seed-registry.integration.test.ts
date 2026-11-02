import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, security, type Database } from '@repopulse/shared';
import { seedAdapterRegistry } from './run.js';
import { resetAdapters } from './adapters/registry.js';
import type { AdapterFinding } from './adapters/types.js';

// Shadow tool findings need a registry row to ever leave shadow (W20-08,
// UX_TODO FND-59). Nothing created `tool.<tool>`, so checkov, hadolint,
// actionlint and shellcheck findings stayed experimental forever. The first
// finding of a shadow tool now seeds its row as a CANDIDATE: in shadow, with
// the clock started, and promoted only by the usual gate (20 findings, 30
// days, under 20% false positives) and a person pressing Promote.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const SLUG = 'w20-08-seed-registry';

const finding = (ruleId: string): AdapterFinding => ({
  ruleId,
  file: 'Dockerfile',
  lineStart: 1,
  lineEnd: 1,
  severity: 2,
  title: ruleId,
  message: 'm',
  dimension: 'iac',
  nativeRule: ruleId.split('.').pop() ?? ruleId,
});

describeIfLiveInfra('seedAdapterRegistry (W20-08)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;

  beforeAll(async () => {
    resetAdapters();
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: SLUG, name: 'W20-08 seed' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'W20-08 seed' } })
      .returning();
    workspaceId = ws!.id;
    await db
      .delete(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, workspaceId));
  });

  afterAll(async () => {
    await db
      .delete(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('seeds one candidate row per shadow tool, and none for an always-on tool', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const seeded = await seedAdapterRegistry(
      db,
      workspaceId,
      [
        finding('tool.hadolint.DL3008'),
        finding('tool.hadolint.DL3009'),
        finding('tool.checkov.CKV_AWS_20'),
        finding('tool.ruff.E501'),
      ],
      now,
    );
    expect(seeded.sort()).toEqual(['tool.checkov', 'tool.hadolint']);
    const rows = await db
      .select()
      .from(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, workspaceId));
    expect(rows.every((r) => r.status === 'candidate')).toBe(true);
    expect(rows.every((r) => r.shadowStartedAt?.getTime() === now.getTime())).toBe(true);
    expect(rows[0]!.provenance).toMatchObject({
      license: 'Apache-2.0',
      author: 'repopulse',
      date: '2026-10-01',
    });
  });

  it('never resets a row a person already moved', async () => {
    await db
      .update(security.ruleRegistry)
      .set({ status: 'active' })
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          eq(security.ruleRegistry.ruleId, 'tool.hadolint'),
        ),
      );
    expect(await seedAdapterRegistry(db, workspaceId, [finding('tool.hadolint.DL3008')])).toEqual(
      [],
    );
    const [row] = await db
      .select({ status: security.ruleRegistry.status })
      .from(security.ruleRegistry)
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          eq(security.ruleRegistry.ruleId, 'tool.hadolint'),
        ),
      );
    expect(row?.status).toBe('active');
  });
});
