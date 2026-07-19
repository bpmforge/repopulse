import { WINDOW_PRESETS, type GlobalSearch } from '../../api/urlState.js';

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
}

export function FilterBar({
  value,
  onChange,
  repoOptions = [],
  personOptions = [],
}: FilterBarProps) {
  return (
    <div className="flex items-center gap-2" data-testid="filter-bar">
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        <span className="sr-only">Time window</span>
        <select
          className="rounded-sm border border-border bg-surface px-2 py-1 text-sm text-fg"
          data-testid="filter-window"
          aria-label="Time window"
          value={
            (WINDOW_PRESETS as readonly string[]).includes(value.window) ? value.window : 'custom'
          }
          onChange={(e) => onChange({ window: e.target.value })}
        >
          {WINDOW_PRESETS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
          {!(WINDOW_PRESETS as readonly string[]).includes(value.window) && (
            <option value={value.window}>custom</option>
          )}
        </select>
      </label>

      <label className="flex items-center gap-1 text-xs text-fg-muted">
        <span className="sr-only">Repositories</span>
        <select
          className="rounded-sm border border-border bg-surface px-2 py-1 text-sm text-fg"
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
    </div>
  );
}
