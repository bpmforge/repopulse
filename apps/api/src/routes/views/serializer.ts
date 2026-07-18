import type { read } from '@repopulse/shared';
import type { ViewConfig, ViewResponse, SharedViewResponse } from './schema.js';

type SavedViewRow = typeof read.savedViews.$inferSelect;

function toViewConfig(config: Record<string, unknown>): ViewConfig {
  return config as ViewConfig;
}

export function serializeView(row: SavedViewRow): ViewResponse {
  return {
    id: row.id,
    name: row.name,
    config: toViewConfig(row.config),
    is_shared: row.isShared,
    share_slug: row.shareSlug,
    is_default: row.isDefaultForOwner,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// SC-17: the only three keys a shared-link viewer (any workspace member,
// not necessarily the owner) may ever see. Listed explicitly, not derived
// from SavedViewRow's keys, so a future column addition (e.g. owner_id)
// fails closed instead of leaking silently — see the snapshot test in
// index.test.ts that asserts this exact set.
export const SHARED_VIEW_ALLOWED_KEYS = ['id', 'name', 'config'] as const;

export function serializeSharedView(row: SavedViewRow): SharedViewResponse {
  return {
    id: row.id,
    name: row.name,
    config: toViewConfig(row.config),
  };
}
