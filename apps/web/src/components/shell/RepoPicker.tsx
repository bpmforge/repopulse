import { useEffect, useId, useRef, useState } from 'react';

// A searchable, org-grouped, multi-select repository picker (W20-22, UX_TODO
// X-06 and ADM-74). The topbar's Repositories filter was a single-select
// native dropdown of every tracked repository: at 500 repositories a lead
// could neither find one by typing nor pick their team's twenty. The
// "Add an agreement" form had no scope control at all. Both use this.
//
// The choice is a DRAFT until Apply, so ticking twenty boxes is one URL change
// and one refetch, not twenty. Escape (or Cancel) drops the draft.

export interface RepoChoice {
  id: string;
  /** "org/name", optionally " · host" when several forges are tracked. */
  label: string;
}

/** The org part of "org/name · host". */
export function orgOf(label: string): string {
  const slash = label.indexOf('/');
  return slash > 0 ? label.slice(0, slash) : label;
}

/** Options matching the search, grouped by org, both sorted. */
export function groupByOrg(
  options: readonly RepoChoice[],
  query: string,
): [string, RepoChoice[]][] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, RepoChoice[]>();
  for (const o of options) {
    if (q && !o.label.toLowerCase().includes(q)) continue;
    const org = orgOf(o.label);
    groups.set(org, [...(groups.get(org) ?? []), o]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([org, list]) => [org, [...list].sort((a, b) => a.label.localeCompare(b.label))]);
}

/** What the closed control says: "All repos", the one name, or "3 repos". */
export function pickerSummary(
  selected: readonly string[],
  options: readonly RepoChoice[],
  allLabel: string,
): string {
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) {
    return options.find((o) => o.id === selected[0])?.label ?? `repo ${selected[0]}`;
  }
  return `${selected.length} repos`;
}

/**
 * A saved repository set (W20-23, UX_TODO X-06): a Saved View holding only
 * `repo_ids`, per user. Ids are strings here, like the options.
 */
export interface SavedRepoSet {
  id: number;
  name: string;
  repoIds: string[];
}

/**
 * What applying a set selects: its repositories that are still offered. A set
 * keeps ids of repositories that were untracked since; putting those in the
 * URL would narrow every screen to something it cannot show. With no options
 * loaded yet nothing can be judged, so the set applies as saved.
 */
export function applicableIds(set: SavedRepoSet, options: readonly RepoChoice[]): string[] {
  if (options.length === 0) return [...set.repoIds];
  const known = new Set(options.map((o) => o.id));
  return set.repoIds.filter((id) => known.has(id));
}

/** True when a set holds exactly the selected repositories, in any order. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

export interface RepoPickerProps {
  options: readonly RepoChoice[];
  /** Selected ids; empty means every repository. */
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  allLabel?: string;
  /** Accessible name of the control. */
  label?: string;
  testId?: string;
  buttonClassName?: string;
  /**
   * W20-23 (UX_TODO X-06): the caller's saved repository sets. Absent = the
   * picker offers no sets (the agreement form, which saves its own scope).
   */
  savedSets?: readonly SavedRepoSet[] | undefined;
  /** Saves the ticked repositories as a named set; rejects with the reason. */
  onSaveSet?: ((name: string, ids: string[]) => Promise<void>) | undefined;
}

export function RepoPicker({
  options,
  selected,
  onChange,
  allLabel = 'All repos',
  label = 'Repositories',
  testId = 'repo-picker',
  buttonClassName = 'h-8 min-w-0 max-w-[14rem] truncate rounded-md border border-border bg-surface px-2 text-left text-sm text-fg hover:border-border-strong',
  savedSets,
  onSaveSet,
}: RepoPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([...selected]);
  const [query, setQuery] = useState('');
  // Naming a new set: null while not naming.
  const [setName, setSetName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // A click outside drops the draft, like Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const apply = () => {
    onChange(draft);
    close();
  };
  const applySet = (set: SavedRepoSet) => {
    onChange(applicableIds(set, options));
    close();
  };
  const saveSet = () => {
    const name = (setName ?? '').trim();
    if (!onSaveSet || name === '' || draft.length === 0) return;
    setSaving(true);
    setSaveError(null);
    onSaveSet(name, draft).then(
      () => {
        setSaving(false);
        setSetName(null);
        // Saving what is ticked is choosing it, too.
        apply();
      },
      (err: unknown) => {
        setSaving(false);
        setSaveError(err instanceof Error ? err.message : 'The set was not saved.');
      },
    );
  };
  const toggle = (id: string) =>
    setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  const groups = groupByOrg(options, query);
  const shownIds = groups.flatMap(([, list]) => list.map((o) => o.id));

  return (
    <div className="relative min-w-0" ref={root} data-testid={testId}>
      <button
        ref={button}
        type="button"
        className={buttonClassName}
        aria-label={`${label}: ${pickerSummary(selected, options, allLabel)}`}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid={`${testId}-button`}
        onClick={() => {
          if (open) return close();
          // Reopening starts from what is applied, not an abandoned draft.
          setDraft([...selected]);
          setQuery('');
          setSetName(null);
          setSaveError(null);
          setOpen(true);
        }}
      >
        {pickerSummary(selected, options, allLabel)} ▾
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()}`}
          className="absolute left-0 z-40 mt-1 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 rounded-md border border-border bg-surface p-2 shadow-lg"
          data-testid={`${testId}-panel`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          {savedSets && savedSets.length > 0 && (
            <div
              className="flex flex-col gap-0.5 border-b border-border pb-2"
              role="group"
              aria-label="Saved repository sets"
              data-testid={`${testId}-sets`}
            >
              <span className="px-1 text-xs font-medium text-fg-muted">Your saved sets</span>
              {savedSets.map((set) => {
                const usable = applicableIds(set, options);
                const gone = set.repoIds.length - usable.length;
                const current = selected.length > 0 && sameIds(usable, selected);
                return (
                  <button
                    key={set.id}
                    type="button"
                    className="flex items-baseline gap-2 rounded-sm px-1 py-0.5 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
                    data-testid={`${testId}-set-${set.id}`}
                    aria-current={current ? 'true' : undefined}
                    disabled={usable.length === 0}
                    onClick={() => applySet(set)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {current ? '✓ ' : ''}
                      {set.name}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {usable.length} {usable.length === 1 ? 'repo' : 'repos'}
                      {gone > 0 && ` · ${gone} no longer tracked`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <input
            type="search"
            // The one thing to do on opening is to type a name.
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                apply();
              }
            }}
            placeholder="Find a repository"
            aria-label="Find a repository"
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid={`${testId}-search`}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              className="text-accent hover:underline"
              data-testid={`${testId}-all`}
              onClick={() => setDraft([])}
            >
              {allLabel}
            </button>
            {query.trim() !== '' && shownIds.length > 0 && (
              <button
                type="button"
                className="text-accent hover:underline"
                data-testid={`${testId}-select-shown`}
                onClick={() => setDraft((d) => [...new Set([...d, ...shownIds])])}
              >
                Select the {shownIds.length} shown
              </button>
            )}
            <span className="text-fg-muted" data-testid={`${testId}-count`}>
              {draft.length === 0 ? 'every repository' : `${draft.length} chosen`}
            </span>
          </div>
          <div
            className="max-h-64 overflow-y-auto"
            role="group"
            aria-label="Repositories by organization"
          >
            {groups.length === 0 && (
              <p className="px-1 py-2 text-xs text-fg-muted">No repository matches.</p>
            )}
            {groups.map(([org, list]) => (
              <fieldset key={org} className="mb-1.5">
                <legend className="px-1 text-xs font-medium text-fg-muted">{org}</legend>
                {list.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={draft.includes(o.id)}
                      onChange={() => toggle(o.id)}
                      data-testid={`${testId}-option-${o.id}`}
                    />
                    <span className="truncate">{o.label}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          {onSaveSet && setName !== null && (
            <form
              className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2"
              data-testid={`${testId}-save-form`}
              onSubmit={(e) => {
                e.preventDefault();
                saveSet();
              }}
            >
              <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-fg-muted">
                Name
                <input
                  type="text"
                  autoFocus
                  maxLength={200}
                  value={setName}
                  onChange={(e) => setSetName(e.target.value)}
                  className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 py-0.5 text-sm text-fg"
                  data-testid={`${testId}-set-name`}
                />
              </label>
              <button
                type="submit"
                className="rounded-md btn-primary px-2 py-1 text-xs disabled:opacity-50"
                disabled={saving || setName.trim() === ''}
                data-testid={`${testId}-set-save`}
              >
                Save set
              </button>
              {saveError && (
                <p
                  role="alert"
                  className="w-full text-xs text-crit"
                  data-testid={`${testId}-set-error`}
                >
                  {saveError}
                </p>
              )}
            </form>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onSaveSet && setName === null && draft.length > 0 && (
              <button
                type="button"
                className="mr-auto text-xs text-accent hover:underline"
                data-testid={`${testId}-save-set`}
                onClick={() => setSetName('')}
              >
                Save these {draft.length} as a set…
              </button>
            )}
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-xs"
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md btn-primary px-2 py-1 text-xs"
              data-testid={`${testId}-apply`}
              onClick={apply}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
