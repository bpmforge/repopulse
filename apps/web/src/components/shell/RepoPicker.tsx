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
}

export function RepoPicker({
  options,
  selected,
  onChange,
  allLabel = 'All repos',
  label = 'Repositories',
  testId = 'repo-picker',
  buttonClassName = 'h-8 min-w-0 max-w-[14rem] truncate rounded-md border border-border bg-surface px-2 text-left text-sm text-fg hover:border-border-strong',
}: RepoPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([...selected]);
  const [query, setQuery] = useState('');
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
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-xs"
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md border border-accent bg-accent/10 px-2 py-1 text-xs"
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
