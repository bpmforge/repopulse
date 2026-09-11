import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useApiQuery } from '../../api/useApiQuery.js';

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

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Only fetched while the palette is open: the shell should not pay for a
  // repo list on every page load to power a panel nobody opened.
  const { data: repos } = useApiQuery<{ items: RepoRow[] }>({ endpoint: '/repos' }, { enabled: open });
  const { data: views } = useApiQuery<{ items: ViewRow[] }>({ endpoint: '/views' }, { enabled: open });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // metaKey OR ctrlKey: the same muscle memory on macOS and elsewhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
        setCursor(0);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const go = (to: string, params?: Record<string, string>) => () => {
      void navigate({ to, ...(params ? { params } : {}) } as never);
    };
    const nav: PaletteItem[] = [
      { id: 'nav:/', label: 'Org Overview', hint: 'Go', run: go('/') },
      { id: 'nav:/repos', label: 'Repos', hint: 'Go', run: go('/repos') },
      { id: 'nav:/pull-requests', label: 'Pull Requests', hint: 'Go', run: go('/pull-requests') },
      { id: 'nav:/me', label: 'My Focus', hint: 'Go', run: go('/me') },
      { id: 'nav:/views', label: 'Views', hint: 'Go', run: go('/views') },
      { id: 'nav:/admin', label: 'Admin', hint: 'Go', run: go('/admin') },
      { id: 'action:new-view', label: 'New view from template…', hint: 'Action', run: go('/views') },
      { id: 'action:identities', label: 'Merge identities', hint: 'Action', run: go('/admin/identities') },
      { id: 'action:settings', label: 'Workspace settings', hint: 'Action', run: go('/admin/settings') },
    ];
    const repoItems = (repos?.items ?? []).map<PaletteItem>((r) => ({
      id: `repo:${r.id}`,
      label: `${r.org}/${r.name}`,
      hint: 'Repo',
      // '/repos/$repoId/' with the trailing slash: $repoId is a LAYOUT route
      // with tab children, so navigating to the layout path alone resolves to
      // no leaf and the URL never changes — it looks like Enter did nothing.
      run: () => void navigate({ to: '/repos/$repoId/', params: { repoId: String(r.id) } } as never),
    }));
    const viewItems = (views?.items ?? []).map<PaletteItem>((v) => ({
      id: `view:${v.id}`,
      label: v.name,
      hint: 'View',
      run: () => void navigate({ to: '/views/$viewId', params: { viewId: String(v.id) } } as never),
    }));
    // Report types are destinations too (§3.3), even before the Report Center
    // exists — they resolve to the reports route W5-04 lands.
    return [...nav, ...repoItems, ...viewItems];
  }, [navigate, repos, views]);

  const matches = useMemo(
    () => orderByRecents(items.filter((i) => fuzzyMatch(query, i.label)), readRecents()).slice(0, 12),
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
    >
      <div className="mt-24 w-full max-w-md panel shadow">
        <input
          ref={inputRef}
          type="text"
          value={query}
          data-testid="palette-input"
          aria-label="Search commands, repositories and views"
          aria-activedescendant={matches[cursor] ? `palette-option-${matches[cursor].id}` : undefined}
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
            }
          }}
        />
        <ul role="listbox" aria-label="Results" className="max-h-64 overflow-auto" data-testid="palette-results">
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
