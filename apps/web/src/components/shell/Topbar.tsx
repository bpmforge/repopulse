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

export function Topbar({ value, onChange, repoOptions, personOptions, actions }: TopbarProps) {
  const sseConnection = useUiStore((s) => s.sseConnection);
  return (
    <header
      className="flex items-center justify-between gap-3 border-b border-border bg-bg px-4 py-2"
      data-testid="topbar"
    >
      <FilterBar
        value={value}
        onChange={onChange}
        repoOptions={repoOptions}
        personOptions={personOptions}
      />
      <div className="flex items-center gap-3">
        {actions}
        <SyncStatusChip connection={sseConnection} />
      </div>
    </header>
  );
}
