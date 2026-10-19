// Component kit barrel (UX §2.2, DASHBOARD §4/§5/§7).
export * from './primitives/index.js';
export { Chart, useChartThemeKey, type ChartProps, type ChartTableData } from './chart/Chart.js';
export { DataTable, type DataTableColumn, type DataTableProps } from './table/DataTable.js';
export { WidgetFrame, frameState, type WidgetFrameProps } from './widget/WidgetFrame.js';
export { WidgetGrid, type WidgetGridProps } from './widget/WidgetGrid.js';
export {
  registerWidget,
  getWidget,
  listWidgets,
  type WidgetDefinition,
  type WidgetComponentProps,
} from './widget/WidgetRegistry.js';
export type { Widget, WidgetType, WidgetLayout, WidgetState, SavedView } from './widget/types.js';
export { Rail, type RailProps } from './shell/Rail.js';
export { Topbar, type TopbarProps } from './shell/Topbar.js';
export { FilterBar, type FilterBarProps, type RepoOption } from './shell/FilterBar.js';
export { Breadcrumb, type Crumb, type BreadcrumbProps } from './shell/Breadcrumb.js';
export { ThemeToggle } from './shell/ThemeToggle.js';
export { Toaster } from './shell/Toaster.js';
export { useUiStore, errorToast } from './store/uiStore.js';
