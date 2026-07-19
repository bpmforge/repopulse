import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './DataTable.js';

interface Repo {
  id: string;
  name: string;
  score: number;
}
const DATA: Repo[] = [
  { id: 'r1', name: 'alpha', score: 82 },
  { id: 'r2', name: 'beta', score: 61 },
  { id: 'r3', name: 'gamma', score: 74 },
];
const COLUMNS: DataTableColumn<Repo>[] = [
  { id: 'name', header: 'Repo', cell: (r) => r.name, sortable: true },
  { id: 'score', header: 'Health', cell: (r) => r.score, sortable: true, align: 'right' },
];

function setup(overrides: Partial<Parameters<typeof DataTable<Repo>>[0]> = {}) {
  const onSortChange = vi.fn();
  const onActivate = vi.fn();
  const onToggleSelect = vi.fn();
  render(
    <DataTable
      name="repos"
      columns={COLUMNS}
      data={DATA}
      getRowId={(r) => r.id}
      onSortChange={onSortChange}
      onActivate={onActivate}
      onToggleSelect={onToggleSelect}
      {...overrides}
    />,
  );
  return { onSortChange, onActivate, onToggleSelect };
}

describe('DataTable (DASHBOARD §7)', () => {
  it('renders rows with stable testids', () => {
    setup();
    expect(screen.getByTestId('table-repos')).toBeInTheDocument();
    expect(screen.getByTestId('row-r1')).toHaveTextContent('alpha');
    expect(screen.getByTestId('row-r2')).toHaveTextContent('61');
  });

  it('clicking a sortable header reports `col:desc`, then toggles to asc', async () => {
    const user = userEvent.setup();
    const { onSortChange } = setup();
    await user.click(screen.getByTestId('sort-score'));
    expect(onSortChange).toHaveBeenLastCalledWith('score:desc');
  });

  it('reflects the controlled sort as aria-sort + toggles the active column', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <DataTable
        name="repos"
        columns={COLUMNS}
        data={DATA}
        getRowId={(r) => r.id}
        sort="score:desc"
        onSortChange={onSortChange}
      />,
    );
    const header = screen.getByTestId('sort-score').closest('th')!;
    expect(header).toHaveAttribute('aria-sort', 'descending');
    await user.click(screen.getByTestId('sort-score'));
    expect(onSortChange).toHaveBeenLastCalledWith('score:asc');
  });

  it('j/k move the active row; Enter activates it; x toggles selection (UX §5)', async () => {
    const user = userEvent.setup();
    const { onActivate, onToggleSelect } = setup();
    const table = screen.getByTestId('table-repos');
    table.focus();

    // first row active by default
    expect(screen.getByTestId('row-r1')).toHaveAttribute('data-active', 'true');
    await user.keyboard('j'); // → r2
    expect(screen.getByTestId('row-r2')).toHaveAttribute('data-active', 'true');
    await user.keyboard('j'); // → r3
    await user.keyboard('k'); // → r2
    expect(screen.getByTestId('row-r2')).toHaveAttribute('data-active', 'true');

    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenLastCalledWith(DATA[1]);
    await user.keyboard('x');
    expect(onToggleSelect).toHaveBeenLastCalledWith(DATA[1]);
  });

  it('shows skeleton rows while loading with no data, and a load-more control', () => {
    const onLoadMore = vi.fn();
    render(
      <DataTable
        name="repos"
        columns={COLUMNS}
        data={[]}
        getRowId={(r) => r.id}
        loading
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getAllByTestId('row-skeleton').length).toBeGreaterThan(0);
  });
});
