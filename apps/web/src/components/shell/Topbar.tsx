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
}: TopbarProps) {
  const sseConnection = useUiStore((s) => s.sseConnection);
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
      />
      <div className="flex items-center gap-3">
        {actions}
        <SyncStatusChip connection={sseConnection} />
      </div>
    </header>
  );
}
