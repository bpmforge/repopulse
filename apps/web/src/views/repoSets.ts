import { useApiMutation, useApiQuery } from '../api/useApiQuery.js';
import type { SavedRepoSet } from '../components/shell/RepoPicker.js';
import {
  isRepoSetView,
  repoSetConfig,
  type ViewListResponse,
  type ViewResponse,
} from './contracts.js';

// Saved repository sets (W20-23, UX_TODO X-06; W20_DECISIONS_2 row 6: per
// user, reusing Saved Views). A set is a Saved View whose config holds only
// `repo_ids` (target `repos`), so it needs no table of its own: the views API
// already scopes every row to its workspace and owner (Law 5), and Saved Views
// is where a set is renamed or deleted.

/** The caller's own views, as many as one page holds. */
export const REPO_SET_SOURCE = { endpoint: '/views', query: { limit: 100 } } as const;

/** Every query under /views — the list pages and this one alike. */
const ALL_VIEW_QUERIES = ['/views'] as const;

/** The repository sets among a list of views, ids as strings like the picker's. */
export function repoSetsOf(items: readonly ViewResponse[] | undefined): SavedRepoSet[] {
  return (items ?? [])
    .filter((v) => isRepoSetView(v.config) && v.is_owner !== false)
    .map((v) => ({ id: v.id, name: v.name, repoIds: v.config.repo_ids.map(String) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface RepoSetsControl {
  sets: SavedRepoSet[];
  save: (name: string, ids: string[]) => Promise<void>;
}

/** The topbar's sets, fetched only where the Repositories filter is shown. */
export function useRepoSets(enabled: boolean): RepoSetsControl {
  const { data } = useApiQuery<ViewListResponse>(REPO_SET_SOURCE, { enabled });
  const create = useApiMutation<{ name: string; config: unknown }, ViewResponse>(
    { endpoint: '/views', method: 'POST' },
    { invalidate: [ALL_VIEW_QUERIES] },
  );
  return {
    sets: repoSetsOf(data?.items),
    save: async (name, ids) => {
      await create.mutateAsync({ name, config: repoSetConfig(ids.map(Number)) });
    },
  };
}
