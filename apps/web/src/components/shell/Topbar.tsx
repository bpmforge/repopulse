import type { ReactNode } from 'react';
import { FilterBar, type FilterBarProps } from './FilterBar.js';
import { SyncStatusChip } from '../primitives/SyncStatusChip.js';
import { useUiStore } from '../store/uiStore.js';

// Top bar (UX §4.a): the three global filters on the left, a live org-sync
// indicator on the right. Presentational — __root wires the FilterBar's onChange
// to router.navigate so filter changes serialize to the URL.

export interface TopbarProps extends FilterBarProps {
  /** Extra right-aligned content (e.g. "Generate report…"). */
  actions?: ReactNode;
}

export function Topbar({
  value,
  onChange,
  repoOptions,
  personOptions,
  scope,
  actions,
  savedRepoSets,
  onSaveRepoSet,
}: TopbarProps) {
  const sseConnection = useUiStore((s) => s.sseConnection);
  const setPalette = useUiStore((s) => s.setPalette);
  return (
    <header
      // W20-12 (UX_TODO DSH-67): wraps on a phone. A long org/repo option
      // pushed the filters and the Live chip past the edge, where the shell's
      // overflow-hidden clipped them out of reach.
      className="flex flex-wrap items-center justify-between gap-3 bg-bg px-4 pt-3 pb-1"
      data-testid="topbar"
    >
      <FilterBar
        value={value}
        onChange={onChange}
        repoOptions={repoOptions}
        personOptions={personOptions}
        scope={scope}
        savedRepoSets={savedRepoSets}
        onSaveRepoSet={onSaveRepoSet}
      />
      <div className="flex items-center gap-3">
        {actions}
        {/* W20-17 (UX_TODO ADM-27): the palette had no visible way in; ⌘K was
            only discoverable by reading the docs. */}
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="hidden items-center gap-2 rounded-sm border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:inline-flex"
          aria-keyshortcuts="Meta+K Control+K"
          data-testid="topbar-search"
        >
          Search <kbd className="font-mono text-[10px] text-fg-faint">⌘K</kbd>
        </button>
        <SyncStatusChip connection={sseConnection} />
      </div>
    </header>
  );
}
