import { WINDOW_PRESETS, type GlobalSearch } from '../../api/urlState.js';
import { customRange, presetCovering } from '@repopulse/shared/url-state';
import type { FilterScope } from '../../api/filterScope.js';

// Global filters (UX §3.4): time window, repo set, person. Controlled — the
// topbar wires `onChange` to router.navigate so every change serializes to the
// URL (?window=&repos=&person=) and the state is shareable/bookmarkable. This
// component holds NO state of its own (DASHBOARD §2: URL is the source of truth).

export interface RepoOption {
  id: string;
  label: string;
}

export interface FilterBarProps {
  value: GlobalSearch;
  onChange: (patch: { window?: string; repos?: string | null; person?: string | null }) => void;
  repoOptions?: RepoOption[] | undefined;
  personOptions?: string[] | undefined;
  /**
   * Which filters this screen actually applies (W16-50). A control the screen
   * ignores is not rendered — it used to be rendered and do nothing, which is
   * the worse of the two.
   */
  scope?: FilterScope | undefined;
}

export function FilterBar({
  value,
  onChange,
  repoOptions = [],
  personOptions = [],
  scope = { window: true, repos: true, person: true },
}: FilterBarProps) {
  // W20-09 (UX_TODO DSH-56). A pasted `start..end` set the select's value to
  // 'custom' while the extra option's value was the range itself, so nothing
  // matched and the control showed "7d". The option's value is now the range,
  // labelled with its dates and the preset the cards actually read.
  const range = customRange(value.window);
  return (
    <div className="flex items-center gap-2" data-testid="filter-bar">
      {/* Nothing at all is a legitimate result: Reports and Views carry their
          own scope, and an empty bar says so more honestly than three dead
          controls did. */}
      {scope.window && (
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <span className="sr-only">Time window</span>
          <select
            className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg hover:border-border-strong"
            data-testid="filter-window"
            aria-label="Time window"
            value={value.window}
            onChange={(e) => onChange({ window: e.target.value })}
          >
            {WINDOW_PRESETS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
            {range && (
              <option value={value.window} data-testid="filter-window-custom">
                {range.start} → {range.end} (as {presetCovering(value.window)})
              </option>
            )}
          </select>
        </label>
      )}

      {scope.repos && (
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <span className="sr-only">Repositories</span>
          <select
            className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg hover:border-border-strong"
            data-testid="filter-repos"
            aria-label="Repositories"
            value={value.repos ?? 'all'}
            onChange={(e) => onChange({ repos: e.target.value === 'all' ? null : e.target.value })}
          >
            <option value="all">All repos</option>
            {repoOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {scope.person && (
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <span className="sr-only">Person</span>
          <input
            className="w-32 rounded-sm border border-border bg-surface px-2 py-1 text-sm text-fg"
            data-testid="filter-person"
            aria-label="Person"
            list="filter-person-options"
            placeholder="Any person"
            value={value.person ?? ''}
            onChange={(e) => onChange({ person: e.target.value || null })}
          />
          <datalist id="filter-person-options">
            {personOptions.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
      )}
    </div>
  );
}
