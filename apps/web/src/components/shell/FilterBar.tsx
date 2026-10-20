import { useEffect, useState } from 'react';
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

  // W20-16 (UX_TODO DSH-56): "Custom range…" asks for two dates instead of
  // asking people to hand-edit the URL. Metrics are still snapshotted per
  // preset, so the chosen dates are read through the smallest preset that
  // covers them, ending today — the option's label says which.
  const [picking, setPicking] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(range?.start ?? '');
  const [to, setTo] = useState(range?.end ?? today);
  const rangeValid =
    /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  // W20-12 (UX_TODO DSH-63): the person box is a DRAFT until Enter, leaving
  // the box, or picking a suggestion. Every keystroke used to push a history
  // entry and refetch — "alice" was five queries, "no PRs" flashed for "a" and
  // "al", and Back stepped out letter by letter. The URL stays the source of
  // truth: the draft resets whenever it changes.
  const [personDraft, setPersonDraft] = useState(value.person ?? '');
  useEffect(() => setPersonDraft(value.person ?? ''), [value.person]);
  const commitPerson = (next: string) => {
    const trimmed = next.trim();
    if (trimmed !== (value.person ?? '')) onChange({ person: trimmed || null });
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="filter-bar">
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
            value={picking ? '__custom' : value.window}
            onChange={(e) => {
              if (e.target.value === '__custom') {
                setPicking(true);
                return;
              }
              setPicking(false);
              onChange({ window: e.target.value });
            }}
          >
            {WINDOW_PRESETS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
            {range && (
              <option value={value.window} data-testid="filter-window-custom">
                {range.start} → {range.end} (numbers: last {presetCovering(value.window)})
              </option>
            )}
            <option value="__custom">Custom range…</option>
          </select>
        </label>
      )}
      {scope.window && picking && (
        <form
          className="flex flex-wrap items-center gap-1 text-xs text-fg-muted"
          data-testid="filter-window-range"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rangeValid) return;
            setPicking(false);
            onChange({ window: `${from}..${to}` });
          }}
        >
          <label className="flex items-center gap-1">
            From
            <input
              type="date"
              className="h-8 rounded-md border border-border bg-surface px-1 text-sm text-fg"
              data-testid="filter-window-from"
              value={from}
              max={to || today}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1">
            to
            <input
              type="date"
              className="h-8 rounded-md border border-border bg-surface px-1 text-sm text-fg"
              data-testid="filter-window-to"
              value={to}
              max={today}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="h-8 rounded-md border border-accent bg-accent/10 px-2 text-sm text-fg disabled:opacity-50"
            disabled={!rangeValid}
            data-testid="filter-window-apply"
          >
            Apply
          </button>
          <button
            type="button"
            className="h-8 rounded-md border border-border px-2 text-sm text-fg"
            onClick={() => setPicking(false)}
          >
            Cancel
          </button>
          {rangeValid && (
            <span data-testid="filter-window-range-note">
              Numbers are read from the last {presetCovering(`${from}..${to}`)}, ending today.
            </span>
          )}
        </form>
      )}

      {scope.repos && (
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <span className="sr-only">Repositories</span>
          {/* min-w-0 + a max width (DSH-67): a native select is as wide as
              its longest option. */}
          <select
            className="h-8 min-w-0 max-w-[14rem] truncate rounded-md border border-border bg-surface px-2 text-sm text-fg hover:border-border-strong"
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
            value={personDraft}
            onChange={(e) => {
              setPersonDraft(e.target.value);
              // Picking a suggestion applies at once; typing does not.
              if (personOptions.includes(e.target.value)) commitPerson(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPerson(personDraft);
              if (e.key === 'Escape') setPersonDraft(value.person ?? '');
            }}
            onBlur={() => commitPerson(personDraft)}
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
