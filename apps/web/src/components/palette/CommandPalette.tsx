import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useApiQuery } from '../../api/useApiQuery.js';
import { navGroups } from '../shell/Rail.js';
import { useUiStore } from '../store/uiStore.js';

// ⌘K command palette (W5-02, UX_SPEC §3.3).
//
// Fully keyboard operable is the requirement, not a nicety: the palette exists
// so someone who knows where they are going does not have to navigate a rail
// and three screens to get there. A palette that needs a mouse to pick a result
// is slower than the rail it replaces.
//
// Data comes from queries the shell already makes cheap: repos and views are
// small workspace-scoped lists. Nothing here calls a forge (Law 4).

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

interface RepoRow {
  id: number;
  org: string;
  name: string;
}
interface ViewRow {
  id: number;
  name: string;
}

const RECENTS_KEY = 'repopulse.palette.recents';
const MAX_RECENTS = 5;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // A corrupt or unavailable store must not break navigation — recents are a
    // convenience, and the palette has to work in private-mode browsers too.
    return [];
  }
}

function pushRecent(id: string): void {
  try {
    const next = [id, ...readRecents().filter((r) => r !== id)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* see readRecents */
  }
}

/**
 * Subsequence match — "orgpay" finds "acme/payments".
 *
 * Deliberately not a fuzzy-distance library: a scoring function nobody can
 * predict makes the top result feel random, and the top result is what Enter
 * selects. Subsequence order-preserving matching is explainable — every
 * character you typed appears, in that order.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Recents first, then declaration order — stable, so Enter is predictable. */
export function orderByRecents(items: PaletteItem[], recents: string[]): PaletteItem[] {
  const rank = new Map(recents.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

/**
 * The palette's destinations and actions (W20-17, UX_TODO ADM-27). Generated
 * from the rail's own navGroups, so the two can never name a screen
 * differently again ("Org Overview", "Repos", "Admin" vs the rail's words),
 * and admin-only actions are not offered to members. Exported for its test.
 */
export function paletteCommands(
  isAdmin: boolean,
): { id: string; label: string; hint: string; to?: string; action?: 'toggle-theme' }[] {
  const nav = navGroups(isAdmin).flatMap((g) =>
    g.items.map((i) => ({ id: `nav:${i.to}`, label: i.label, hint: 'Go', to: i.to })),
  );
  return [
    ...nav,
    { id: 'action:report', label: 'Generate report…', hint: 'Action', to: '/reports' },
    { id: 'action:new-view', label: 'New view from template…', hint: 'Action', to: '/views' },
    { id: 'action:theme', label: 'Toggle theme', hint: 'Action', action: 'toggle-theme' as const },
    ...(isAdmin
      ? [
          {
            id: 'action:identities',
            label: 'Merge identities',
            hint: 'Action',
            to: '/admin/identities',
          },
          { id: 'action:connections', label: 'Connect a forge', hint: 'Action', to: '/admin' },
          {
            id: 'action:settings',
            label: 'Scoring settings',
            hint: 'Action',
            to: '/admin/settings',
          },
          { id: 'action:health', label: 'System health', hint: 'Action', to: '/admin' },
        ]
      : []),
  ];
}

export function CommandPalette({
  isAdmin = false,
  search,
}: {
  isAdmin?: boolean;
  /** The preserved global filters (window, repos), kept on every jump (ADM-63). */
  search?: Record<string, string>;
} = {}) {
  // In the store (W20-17, UX_TODO ADM-28) so the top bar's Search button can
  // open it: ⌘K alone left phone and mouse users without a palette.
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPalette);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();

  // Only fetched while the palette is open: the shell should not pay for a
  // repo list on every page load to power a panel nobody opened.
  const { data: repos } = useApiQuery<{ items: RepoRow[] }>(
    { endpoint: '/repos' },
    { enabled: open },
  );
  const { data: views } = useApiQuery<{ items: ViewRow[] }>(
    { endpoint: '/views' },
    { enabled: open },
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // metaKey OR ctrlKey: the same muscle memory on macOS and elsewhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUiStore.getState().paletteOpen);
      }
      if (e.key === 'Escape' && useUiStore.getState().paletteOpen) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  // Opening: fresh query, remember who opened it, focus the input. Closing:
  // focus goes back to that element (W20-17, UX_TODO ADM-28).
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setCursor(0);
      inputRef.current?.focus();
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && document.contains(opener)) opener.focus();
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    // W20-17 (UX_TODO ADM-63): every jump keeps the global filters, as the
    // rail, drawer and breadcrumb already do.
    const withSearch = search && Object.keys(search).length > 0 ? { search } : {};
    const go = (to: string) => () => {
      void navigate({ to, ...withSearch } as never);
    };
    const nav: PaletteItem[] = paletteCommands(isAdmin).map((c) => ({
      id: c.id,
      label: c.label,
      hint: c.hint,
      run: c.action === 'toggle-theme' ? toggleTheme : go(c.to ?? '/'),
    }));
    const repoItems = (repos?.items ?? []).map<PaletteItem>((r) => ({
      id: `repo:${r.id}`,
      label: `${r.org}/${r.name}`,
      hint: 'Repo',
      // '/repos/$repoId/' with the trailing slash: $repoId is a LAYOUT route
      // with tab children, so navigating to the layout path alone resolves to
      // no leaf and the URL never changes — it looks like Enter did nothing.
      run: () =>
        void navigate({
          to: '/repos/$repoId/',
          params: { repoId: String(r.id) },
          ...withSearch,
        } as never),
    }));
    const viewItems = (views?.items ?? []).map<PaletteItem>((v) => ({
      id: `view:${v.id}`,
      label: v.name,
      hint: 'View',
      run: () =>
        void navigate({
          to: '/views/$viewId',
          params: { viewId: String(v.id) },
          ...withSearch,
        } as never),
    }));
    // Report types are destinations too (§3.3), even before the Report Center
    // exists — they resolve to the reports route W5-04 lands.
    return [...nav, ...repoItems, ...viewItems];
  }, [navigate, repos, views, isAdmin, search, toggleTheme]);

  const matches = useMemo(
    () =>
      orderByRecents(
        items.filter((i) => fuzzyMatch(query, i.label)),
        readRecents(),
      ).slice(0, 12),
    [items, query],
  );

  if (!open) return null;

  const choose = (item: PaletteItem) => {
    pushRecent(item.id);
    setOpen(false);
    item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/80 p-4 backdrop-blur"
      data-testid="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      // W20-17 (ADM-28): a click on the backdrop (not the panel) closes it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="mt-24 w-full max-w-md panel shadow">
        <input
          ref={inputRef}
          type="text"
          value={query}
          data-testid="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-autocomplete="list"
          aria-label="Search commands, repositories and views"
          aria-activedescendant={
            matches[cursor] ? `palette-option-${matches[cursor].id}` : undefined
          }
          placeholder="Jump to a repo, view or action…"
          className="w-full rounded-t-md border-b border-border bg-surface px-3 py-2 text-sm focus-visible:outline-none"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const item = matches[cursor];
              if (item) choose(item);
            } else if (e.key === 'Tab') {
              // The input is the dialog's only tab stop (results are chosen
              // with the arrows), so Tab stays here rather than escaping into
              // the page behind the modal (ADM-28).
              e.preventDefault();
            }
          }}
        />
        <ul
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="max-h-64 overflow-auto"
          data-testid="palette-results"
        >
          {matches.map((item, i) => (
            <li
              key={item.id}
              id={`palette-option-${item.id}`}
              role="option"
              aria-selected={i === cursor}
              className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm ${
                i === cursor ? 'bg-accent/20' : ''
              }`}
              data-testid={`palette-item-${item.id}`}
              onMouseDown={() => choose(item)}
            >
              <span className="truncate">{item.label}</span>
              <span className="ml-2 shrink-0 text-xs text-fg-muted">{item.hint}</span>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-2 text-sm text-fg-muted">No matches for “{query}”.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
