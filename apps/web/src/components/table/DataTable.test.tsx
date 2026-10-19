import { useState } from 'react';
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

// W20-04 (UX_TODO ADM-58). Every table swallowed Enter, though no screen used
// it, so a keyboard user could not press a button or follow a link in a cell.
describe('DataTable keyboard ownership (W20-04)', () => {
  const pressed = vi.fn();
  const WITH_BUTTON: DataTableColumn<Repo>[] = [
    { id: 'name', header: 'Repo', cell: (r) => r.name },
    {
      id: 'act',
      header: 'Action',
      cell: (r) => (
        <button type="button" data-testid={`act-${r.id}`} onClick={() => pressed(r.id)}>
          Act
        </button>
      ),
    },
  ];

  it('Enter on a button inside a cell presses the button, not the row', async () => {
    const user = userEvent.setup();
    pressed.mockClear();
    const onActivate = vi.fn();
    render(
      <DataTable
        name="repos"
        columns={WITH_BUTTON}
        data={DATA}
        getRowId={(r) => r.id}
        onActivate={onActivate}
      />,
    );
    screen.getByTestId('act-r2').focus();
    await user.keyboard('{Enter}');
    expect(pressed).toHaveBeenCalledWith('r2');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('a table nobody activates rows in has no row highlight, pointer or key handling', async () => {
    const user = userEvent.setup();
    pressed.mockClear();
    render(<DataTable name="repos" columns={WITH_BUTTON} data={DATA} getRowId={(r) => r.id} />);
    const table = screen.getByTestId('table-repos');
    expect(table).not.toHaveAttribute('tabindex');
    expect(screen.getByTestId('row-r1')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('row-r1').className).not.toContain('cursor-pointer');
    screen.getByTestId('act-r1').focus();
    await user.keyboard('{Enter}');
    expect(pressed).toHaveBeenCalledWith('r1');
  });

  it('a cell keeps its own state when the table re-renders', async () => {
    // flexRender used to remount every cell on every parent render, so an open
    // confirm step closed itself whenever any query on the screen refetched.
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <button type="button" data-testid="toggle" onClick={() => setOpen(true)}>
          {open ? 'open' : 'closed'}
        </button>
      );
    }
    const cols: DataTableColumn<Repo>[] = [{ id: 't', header: 'T', cell: () => <Toggle /> }];
    const user = userEvent.setup();
    const { rerender } = render(
      <DataTable name="repos" columns={cols} data={DATA.slice(0, 1)} getRowId={(r) => r.id} />,
    );
    await user.click(screen.getByTestId('toggle'));
    rerender(
      <DataTable name="repos" columns={[...cols]} data={DATA.slice(0, 1)} getRowId={(r) => r.id} />,
    );
    expect(screen.getByTestId('toggle')).toHaveTextContent('open');
  });
});
