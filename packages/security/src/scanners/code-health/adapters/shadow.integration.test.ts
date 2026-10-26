import 'dotenv/config';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, security, type Database } from '@repopulse/shared';
import { adapterShadowState, adapterToIncoming } from '../run.js';
import type { AdapterFinding } from './types.js';

// Shadow mode for the W18-26 adapters (CODE_HEALTH_SUITE.md §8.2), against
// the real rule_registry table: no registry row → candidate → experimental;
// `active` → live; `deprecated` → not stored at all. A tool-level row
// (`tool.checkov`) covers every rule of that tool unless a rule has its own.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const finding = (ruleId: string): AdapterFinding => ({
  ruleId,
  file: 'main.tf',
  lineStart: 1,
  lineEnd: 2,
  severity: 4,
  title: ruleId,
  message: 'm',
  dimension: ruleId.startsWith('tool.checkov.') ? 'iac' : 'correctness',
  nativeRule: ruleId.split('.').slice(2).join('.'),
});

describeIfDb('tool-adapter shadow mode (W18-26)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w18-26-shadow', name: 'W18-26 shadow' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'W18-26 shadow' } })
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

  const provenance = { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' };

  it('stores a new adapter’s findings as experimental, and leaves ruff alone', async () => {
    const checkov = finding('tool.checkov.CKV_AWS_24');
    const ruff = finding('tool.ruff.E722');
    const { kept, experimental } = await adapterShadowState(db, workspaceId, [checkov, ruff]);
    expect(kept).toEqual([checkov, ruff]);

    const incoming = adapterToIncoming(kept, experimental);
    expect(incoming[0]).toMatchObject({ experimental: true, dimension: 'iac' });
    // ruff predates the lifecycle: no opinion stated, so an existing row keeps
    // whatever flag it had rather than being silently re-classified.
    expect(incoming[1]).not.toHaveProperty('experimental');
    expect(incoming[1]?.dimension).toBe('code_health');
  });

  it('honours the registry: rule row beats tool row; active is live, deprecated is dropped', async () => {
    await db.insert(security.ruleRegistry).values([
      { workspaceId, ruleId: 'tool.checkov', status: 'active', provenance },
      { workspaceId, ruleId: 'tool.checkov.CKV_K8S_14', status: 'deprecated', provenance },
      { workspaceId, ruleId: 'tool.hadolint.DL3007', status: 'active', provenance },
    ]);
    const findings = [
      finding('tool.checkov.CKV_AWS_24'), // tool row → active
      finding('tool.checkov.CKV_K8S_14'), // own row → deprecated
      finding('tool.hadolint.DL3007'), // own row → active
      finding('tool.hadolint.DL3008'), // nothing → candidate
    ];
    const { kept, experimental } = await adapterShadowState(db, workspaceId, findings);
    expect(kept.map((f) => f.ruleId)).toEqual([
      'tool.checkov.CKV_AWS_24',
      'tool.hadolint.DL3007',
      'tool.hadolint.DL3008',
    ]);
    expect(kept.map((f) => experimental.get(f))).toEqual([false, false, true]);
  });

  // W21-04: tool.hadolint.DL3018 is in the starter set (measured on real files);
  // DL3008 is not. Each case starts from an empty registry for hadolint.
  describe('the starter set (W21-04)', () => {
    const clear = () =>
      db
        .delete(security.ruleRegistry)
        .where(
          and(
            eq(security.ruleRegistry.workspaceId, workspaceId),
            like(security.ruleRegistry.ruleId, 'tool.hadolint%'),
          ),
        );
    let adminId = 0;

    beforeAll(async () => {
      const [user] = await db
        .insert(core.users)
        .values({
          authProvider: 'local',
          authSubject: `w21-04-admin-${Date.now()}`,
          login: 'w21-04-admin',
        })
        .returning();
      adminId = user!.id;
    });

    afterAll(async () => {
      await clear();
      await db.delete(core.users).where(eq(core.users.id, adminId));
    });

    const states = async () => {
      const findings = [finding('tool.hadolint.DL3018'), finding('tool.hadolint.DL3008')];
      const { kept, experimental } = await adapterShadowState(db, workspaceId, findings);
      return kept.map((f) => [f.ruleId, experimental.get(f)]);
    };

    it('is live with no row, and with only the tool row the scan seeds itself', async () => {
      await clear();
      expect(await states()).toEqual([
        ['tool.hadolint.DL3018', false],
        ['tool.hadolint.DL3008', true],
      ]);
      await db.insert(security.ruleRegistry).values({
        workspaceId,
        ruleId: 'tool.hadolint',
        status: 'candidate',
        provenance,
        shadowStartedAt: new Date(),
      });
      expect(await states()).toEqual([
        ['tool.hadolint.DL3018', false],
        ['tool.hadolint.DL3008', true],
      ]);
    });

    it('an admin moving the rule to shadow wins', async () => {
      await clear();
      await db.insert(security.ruleRegistry).values({
        workspaceId,
        ruleId: 'tool.hadolint.DL3018',
        status: 'candidate',
        provenance: { ...provenance, source: 'pack_override' },
        updatedBy: adminId,
      });
      expect(await states()).toEqual([
        ['tool.hadolint.DL3018', true],
        ['tool.hadolint.DL3008', true],
      ]);
    });

    it('an admin’s decision on the whole tool wins too', async () => {
      await clear();
      await db.insert(security.ruleRegistry).values({
        workspaceId,
        ruleId: 'tool.hadolint',
        status: 'deprecated',
        provenance,
        updatedBy: adminId,
      });
      expect(await states()).toEqual([]);
      await clear();
      // Retired, then returned to shadow by an admin: their name is on it.
      await db.insert(security.ruleRegistry).values({
        workspaceId,
        ruleId: 'tool.hadolint',
        status: 'candidate',
        provenance,
        updatedBy: adminId,
      });
      expect(await states()).toEqual([
        ['tool.hadolint.DL3018', true],
        ['tool.hadolint.DL3008', true],
      ]);
    });
  });

  it('is workspace-scoped: another workspace’s promotion does not leak in', async () => {
    const { experimental, kept } = await adapterShadowState(db, workspaceId + 1_000_000, [
      finding('tool.checkov.CKV_AWS_24'),
    ]);
    expect(experimental.get(kept[0]!)).toBe(true);
  });
});
