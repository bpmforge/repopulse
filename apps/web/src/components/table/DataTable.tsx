import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
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
}

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
  } = props;

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

  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
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

  return (
    <div className="overflow-x-auto">
      <table
        className="w-full border-collapse text-sm tabular-nums"
        data-testid={`table-${name}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
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
                    className={`${rowHeight} cursor-pointer border-b border-border/60 ${
                      index === activeIndex ? 'bg-surface-2' : 'hover:bg-surface-2/50'
                    }`}
                    data-testid={`row-${id}`}
                    data-active={index === activeIndex}
                    aria-selected={selected}
                    onClick={() => {
                      setActiveIndex(index);
                      onActivate?.(row.original);
                    }}
                  >
                    {row.getVisibleCells().map((cell, i) => (
                      <td
                        key={cell.id}
                        className={`px-3 ${columns[i]!.align === 'right' ? 'text-right' : 'text-left'}`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
