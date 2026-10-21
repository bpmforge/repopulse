import { csvFileName, downloadCsv, tableToRows, toCsv } from '../../lib/csv.js';
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import type { Density } from '../store/uiStore.js';

// One DataTable for every list (findings, PRs, hotspots, reports — DASHBOARD §7).
// URL-synced sort/cursor (the container owns the router; this reports changes),
// j/k/Enter/x keyboard nav (UX §5), density-aware row height, skeleton rows,
// cursor "load more". Rows render shared primitives via the column `cell`.
//
// Sorting + pagination are MANUAL: data arrives pre-sorted/paged from the API,
// so this never re-sorts client-side — it just reflects and reports state.
// (Row virtualization via @tanstack/react-virtual layers on for very large
// lists; the render path below stays the source of truth for row content.)

export interface DataTableColumn<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
}

export interface DataTableProps<T> {
  name: string;
  columns: DataTableColumn<T>[];
  data: T[];
  getRowId: (row: T) => string;
  /** `${col}:asc|desc` (TableSearch) — controlled by the URL. */
  sort?: string;
  onSortChange?: (sort: string) => void;
  onActivate?: (row: T) => void;
  onToggleSelect?: (row: T) => void;
  selectedIds?: ReadonlySet<string>;
  density?: Density;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /**
   * W20-20 (UX_TODO DSH-71): offer "Download CSV" of the rows on screen.
   * On by default; a table of controls (settings, forms) turns it off.
   */
  exportable?: boolean;
}

/** Elements that own their own click and Enter (W20-04, UX_TODO ADM-58). */
const CONTROLS = 'a, button, input, select, textarea, label, summary';

function nextSort(current: string | undefined, col: string): string {
  const [curCol, curDir] = (current ?? '').split(':');
  if (curCol !== col) return `${col}:desc`;
  return curDir === 'desc' ? `${col}:asc` : `${col}:desc`;
}

export function DataTable<T>(props: DataTableProps<T>) {
  const {
    name,
    columns,
    data,
    getRowId,
    sort,
    onSortChange,
    onActivate,
    onToggleSelect,
    selectedIds,
    density = 'comfortable',
    loading = false,
    hasMore = false,
    onLoadMore,
    exportable = true,
  } = props;
  const tableRef = useRef<HTMLTableElement | null>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);

  const tableColumns: ColumnDef<T>[] = columns.map((c) => ({
    id: c.id,
    header: c.header,
    cell: ({ row }) => c.cell(row.original),
  }));
  const table = useReactTable({
    data,
    columns: tableColumns,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
  });

  const rows = table.getRowModel().rows;
  const [sortCol, sortDir] = (sort ?? '').split(':');
  const rowHeight = density === 'compact' ? 'h-8' : 'h-10';

  // W20-04 (UX_TODO ADM-58). Row navigation is a feature of tables that DO
  // something with a row. Every table used to grab j/k/arrows/Enter, and no
  // screen passed onActivate, so Enter on a button or link inside a cell was
  // cancelled and then went nowhere — keyboard users could not follow a link
  // in a table at all, and the arrow keys stopped the page from scrolling.
  const interactive = onActivate !== undefined || onToggleSelect !== undefined;

  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    // Only keys pressed ON THE TABLE ITSELF. A key that bubbled up from a
    // button, link or input inside a cell belongs to that control.
    if (!interactive || e.target !== e.currentTarget) return;
    const max = rows.length - 1;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, max));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) onActivate?.(row.original);
    } else if (e.key === 'x') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) onToggleSelect?.(row.original);
    }
  }

  const exportCsv = () => {
    if (!tableRef.current) return;
    const { header, rows: cells } = tableToRows(tableRef.current);
    downloadCsv(csvFileName(name), toCsv(header, cells));
  };

  return (
    <div className="overflow-x-auto">
      {exportable && data.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex min-h-6 items-center rounded-sm px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg"
            data-testid={`table-${name}-csv`}
          >
            Download CSV
          </button>
        </div>
      )}
      <table
        ref={tableRef}
        className="w-full border-collapse text-sm tabular-nums"
        data-testid={`table-${name}`}
        {...(interactive ? { tabIndex: 0, onKeyDown } : {})}
        aria-rowcount={data.length}
      >
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header, i) => {
                const col = columns[i]!;
                const isSorted = sortCol === col.id;
                return (
                  <th
                    key={header.id}
                    className={`sticky top-0 z-10 border-b border-border bg-surface px-3 py-2 text-[13px] font-medium text-fg-muted ${
                      col.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                    aria-sort={isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-fg"
                        onClick={() => onSortChange?.(nextSort(sort, col.id))}
                        data-testid={`sort-${col.id}`}
                      >
                        {col.header}
                        <span aria-hidden="true">
                          {isSorted ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody ref={bodyRef}>
          {loading && data.length === 0
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={`skeleton-${i}`} className={rowHeight} data-testid="row-skeleton">
                  {columns.map((c) => (
                    <td key={c.id} className="px-3">
                      <div className="h-3 w-2/3 animate-pulse rounded-sm bg-surface-2" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, index) => {
                const id = row.id;
                const selected = selectedIds?.has(id) ?? false;
                return (
                  <tr
                    key={id}
                    // A highlight and a pointer promise that the row does
                    // something; only an interactive table makes that promise.
                    className={`${rowHeight} border-b border-border/60 ${
                      interactive
                        ? `cursor-pointer ${index === activeIndex ? 'bg-surface-2' : 'hover:bg-surface-2/50'}`
                        : ''
                    }`}
                    data-testid={`row-${id}`}
                    data-active={interactive && index === activeIndex}
                    aria-selected={selected}
                    {...(interactive
                      ? {
                          onClick: (e: MouseEvent<HTMLTableRowElement>) => {
                            // A control inside the row handles its own click;
                            // activating the row as well would do two things.
                            if ((e.target as Element).closest(CONTROLS)) return;
                            setActiveIndex(index);
                            onActivate?.(row.original);
                          },
                        }
                      : {})}
                  >
                    {row.getVisibleCells().map((cell, i) => (
                      <td
                        key={cell.id}
                        className={`px-3 ${columns[i]!.align === 'right' ? 'text-right' : 'text-left'}`}
                      >
                        {/* The column's own renderer, called directly (W20-04).
                            flexRender treats the per-render arrow in
                            `tableColumns` as a component TYPE, so every parent
                            render remounted every cell and threw away its state
                            — an open "Remove…" or "Make admin…" confirm closed
                            itself the moment any query under the screen
                            refetched. */}
                        {columns[i]!.cell(row.original)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
      {hasMore && (
        <div className="flex justify-center p-2">
          <button
            type="button"
            onClick={() => onLoadMore?.()}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted hover:border-border-strong hover:text-fg"
            data-testid="table-load-more"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
