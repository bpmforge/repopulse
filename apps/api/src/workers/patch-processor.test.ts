import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Database } from '@repopulse/shared';
import { patchProcessor, type PatchJobData } from './patch-processor.js';

// patches.draft processor (W18-19). The drafting job itself is covered against
// Postgres in packages/security; what is pinned here is the hand-off: the
// workspace's own gateway and the repo's forge reach the job, a decided row is
// left alone, and a resolution error lands on the ROW rather than only in the
// dead-letter queue.

function stubDb(row: { repoId: number; status: string } | undefined, paused = false) {
  const updates: Record<string, unknown>[] = [];
  // One stub row answers both reads: the patch row and the AI switch (`paused`).
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (row ? [{ ...row, paused }] : []) }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  } as unknown as Database;
  return { db, updates };
}

const job = (data: PatchJobData) => ({ data }) as Job<PatchJobData>;

describe('patchProcessor', () => {
  it("hands this workspace's gateway and the repo's forge to the drafting job", async () => {
    const { db } = stubDb({ repoId: 7, status: 'pending' });
    const gateway = { complete: vi.fn(), health: vi.fn() };
    const forge = { provider: {} as never, repoFullName: 'acme/x' };
    const gatewayFor = vi.fn(async () => gateway);
    const forgeFor = vi.fn(async () => forge);
    const run = vi.fn(async () => ({
      status: 'verified' as const,
      code: 'verified',
      reason: 'ok',
    }));

    const result = await patchProcessor({ db, gatewayFor, forgeFor, run })(
      job({ workspaceId: 3, patchId: 11 }),
    );
    expect(result.status).toBe('verified');
    expect(gatewayFor).toHaveBeenCalledWith(3);
    expect(forgeFor).toHaveBeenCalledWith(3, 7);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 3, patchId: 11, gateway, forge }),
    );
  });

  it('leaves a decided row alone (a duplicate job spends nothing)', async () => {
    const { db } = stubDb({ repoId: 7, status: 'verified' });
    const run = vi.fn();
    const gatewayFor = vi.fn();
    const result = await patchProcessor({ db, gatewayFor, forgeFor: vi.fn(), run })(
      job({ workspaceId: 3, patchId: 11 }),
    );
    expect(result).toMatchObject({ status: 'skipped', code: 'already_decided' });
    expect(run).not.toHaveBeenCalled();
    expect(gatewayFor).not.toHaveBeenCalled();
  });

  it('records a forge-resolution error on the row, in its own words', async () => {
    const { db, updates } = stubDb({ repoId: 7, status: 'pending' });
    const result = await patchProcessor({
      db,
      gatewayFor: async () => null,
      forgeFor: async () => {
        throw new Error('ciphertext too short');
      },
      run: vi.fn(),
    })(job({ workspaceId: 3, patchId: 11 }));
    expect(result.status).toBe('failed');
    expect(updates[0]).toMatchObject({ status: 'failed', reason: 'ciphertext too short' });
  });

  // W20-18 (UX_TODO AI-77): off means off, for a fix a person asked for too.
  it('AI switched off after the draft was queued: no model is asked, the row says why', async () => {
    const { db, updates } = stubDb({ repoId: 7, status: 'pending' }, true);
    const gatewayFor = vi.fn();
    const run = vi.fn();
    const result = await patchProcessor({ db, gatewayFor, forgeFor: vi.fn(), run })(
      job({ workspaceId: 3, patchId: 11 }),
    );
    expect(result).toMatchObject({ status: 'failed', code: 'ai_paused' });
    expect(gatewayFor).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'failed', reasonCode: 'ai_paused' });
  });
});
