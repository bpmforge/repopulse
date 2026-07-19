import {
  DEFAULT_WINDOW,
  parseGlobalSearch,
  serializeGlobalSearch,
  type GlobalSearch,
} from '@repopulse/shared/url-state';

// Web adapters over the canonical URL contract (@repopulse/shared/url-state —
// the one shared module web imports at runtime). These wire the contract into
// TanStack Router: `validateGlobalSearch` is the root route's validateSearch,
// and `mergeGlobalSearch` computes the next clean search record when a global
// filter changes, preserving the other filters (DASHBOARD §1: drill-down keeps
// window/repos/person; defaults omitted from the URL).

export type { GlobalSearch, WindowPreset } from '@repopulse/shared/url-state';
export { DEFAULT_WINDOW, WINDOW_PRESETS } from '@repopulse/shared/url-state';

/** Root route validateSearch — lenient parse so a bad URL never white-screens. */
export function validateGlobalSearch(search: Record<string, unknown>): GlobalSearch {
  return parseGlobalSearch(search);
}

/**
 * Apply a partial change to the current global search and return the URL search
 * record with defaults omitted. `null` on repos/person clears the filter.
 */
export function mergeGlobalSearch(
  current: GlobalSearch,
  patch: Partial<Record<'window' | 'repos' | 'person', string | null>>,
): Record<string, string> {
  const next: GlobalSearch = { window: current.window };
  if (current.repos) next.repos = current.repos;
  if (current.person) next.person = current.person;

  for (const key of ['window', 'repos', 'person'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (key === 'window') {
      next.window = value && value.length > 0 ? value : DEFAULT_WINDOW;
    } else if (value && value.length > 0) {
      next[key] = value;
    } else {
      delete next[key];
    }
  }
  return serializeGlobalSearch(next);
}
