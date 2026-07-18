import { describe, expect, it } from 'vitest';
import type { read } from '@repopulse/shared';
import { SHARED_VIEW_ALLOWED_KEYS, serializeSharedView, serializeView } from './serializer.js';

type SavedViewRow = typeof read.savedViews.$inferSelect;

const row: SavedViewRow = {
  id: 1,
  workspaceId: 10,
  ownerUserId: 100,
  name: 'My View',
  config: { repo_ids: [1, 2], window: '30d', layout: [{ type: 'kpi' }] },
  isShared: true,
  shareSlug: 'deadbeefdeadbeefdeadbeefdeadbeef',
  isDefaultForOwner: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

describe('serializeSharedView (SC-17 allowlist)', () => {
  it('exposes exactly the allowed key set — a new field must be consciously allowlisted', () => {
    expect(Object.keys(serializeSharedView(row)).sort()).toEqual(
      [...SHARED_VIEW_ALLOWED_KEYS].sort(),
    );
  });

  it('never includes owner, workspace, or sharing-mechanism fields', () => {
    const shared = serializeSharedView(row) as Record<string, unknown>;
    expect(shared).not.toHaveProperty('ownerUserId');
    expect(shared).not.toHaveProperty('owner_id');
    expect(shared).not.toHaveProperty('workspaceId');
    expect(shared).not.toHaveProperty('workspace_id');
    expect(shared).not.toHaveProperty('share_slug');
    expect(shared).not.toHaveProperty('is_shared');
  });
});

describe('serializeView (owner-facing)', () => {
  it('includes the full owner shape', () => {
    expect(serializeView(row)).toEqual({
      id: 1,
      name: 'My View',
      config: { repo_ids: [1, 2], window: '30d', layout: [{ type: 'kpi' }] },
      is_shared: true,
      share_slug: 'deadbeefdeadbeefdeadbeefdeadbeef',
      is_default: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });
});
