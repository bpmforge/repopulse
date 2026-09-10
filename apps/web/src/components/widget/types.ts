import type { QueryDescriptor } from '../../api/useApiQuery.js';
import type { GlobalSearch } from '../../api/urlState.js';

// Widget model (DASHBOARD §4). Powers Org Overview, My Focus, and saved views —
// one grid engine renders them all; views differ by config, not page builds.

export type WidgetType =
  | 'kpi'
  | 'trend'
  | 'health-grid'
  | 'hotspot-list'
  | 'treemap'
  | 'stage-funnel'
  | 'review-matrix'
  | 'histogram'
  | 'pr-table'
  | 'finding-table'
  | 'attention-feed'
  // W5-07. Its own type rather than reusing attention-feed: registerWidget
  // overwrites by type, so a duplicate registration silently replaces the
  // widget already there.
  | 'plan-progress'
  // W6-06. Its own type: registerWidget overwrites by type, so reusing one
  // would silently replace an existing widget.
  | 'weekly-pulse'
  // W8-10. Its own type, for the same reason as the two above.
  | 'security-rollup'
  // W9-11.
  | 'top-risks'
  // W10-05.
  | 'risk-axes'
  // W17-17. Its own type, same reason as the ones above.
  | 'top-actions'
  | 'my-prs'
  | 'my-queue'
  | 'text';

export interface WidgetLayout {
  x: number;
  y: number;
  /** width/height in 12-col grid units. */
  w: number;
  h: number;
}

export interface Widget {
  id: string;
  type: WidgetType;
  query?: QueryDescriptor;
  layout: WidgetLayout;
  options?: Record<string, unknown>;
}

export interface SavedView {
  id: string;
  name: string;
  scope: GlobalSearch;
  widgets: Widget[];
  ownerId: number;
  sharedWithWorkspace: boolean;
  isHome: boolean;
}

/** The frame's finite states (UX §4 intro / DASHBOARD §4). */
export type WidgetState = 'loading' | 'syncing' | 'empty' | 'error' | 'ready';
