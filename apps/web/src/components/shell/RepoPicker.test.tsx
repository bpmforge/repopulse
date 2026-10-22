import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepoPicker, applicableIds, sameIds, type SavedRepoSet } from './RepoPicker.js';
import { repoSetsOf } from '../../views/repoSets.js';
import { repoSetConfig, type ViewResponse } from '../../views/contracts.js';

// W20-23 (UX_TODO X-06; W20_DECISIONS_2 row 6): saved repository sets, per
// user, kept as Saved Views and picked from the topbar's Repositories filter.

const OPTIONS = [
  { id: '1', label: 'acme/web' },
  { id: '2', label: 'acme/api' },
  { id: '3', label: 'beta/app' },
];
const SETS: SavedRepoSet[] = [
  { id: 10, name: 'Payments', repoIds: ['1', '2'] },
  { id: 11, name: 'Old team', repoIds: ['3', '42'] },
];

function open() {
  fireEvent.click(screen.getByTestId('filter-repos-button'));
}

describe('saved repository sets in the picker (W20-23)', () => {
  it('applies a set in one click, leaving out repositories no longer tracked', () => {
    const onChange = vi.fn();
    render(
      <RepoPicker
        testId="filter-repos"
        options={OPTIONS}
        selected={[]}
        onChange={onChange}
        savedSets={SETS}
        onSaveSet={vi.fn()}
      />,
    );
    open();
    expect(screen.getByTestId('filter-repos-set-11')).toHaveTextContent(
      'Old team1 repo · 1 no longer tracked',
    );
    fireEvent.click(screen.getByTestId('filter-repos-set-10'));
    expect(onChange).toHaveBeenCalledWith(['1', '2']);
    expect(screen.queryByTestId('filter-repos-panel')).toBeNull();
  });

  it('marks the set that is applied', () => {
    render(
      <RepoPicker
        testId="filter-repos"
        options={OPTIONS}
        selected={['2', '1']}
        onChange={vi.fn()}
        savedSets={SETS}
      />,
    );
    open();
    expect(screen.getByTestId('filter-repos-set-10')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('filter-repos-set-11')).not.toHaveAttribute('aria-current');
  });

  it('saves the ticked repositories under a name, then applies them', async () => {
    const onChange = vi.fn();
    const onSaveSet = vi.fn().mockResolvedValue(undefined);
    render(
      <RepoPicker
        testId="filter-repos"
        options={OPTIONS}
        selected={[]}
        onChange={onChange}
        savedSets={[]}
        onSaveSet={onSaveSet}
      />,
    );
    open();
    // Nothing ticked: nothing to save.
    expect(screen.queryByTestId('filter-repos-save-set')).toBeNull();
    fireEvent.click(screen.getByTestId('filter-repos-option-1'));
    fireEvent.click(screen.getByTestId('filter-repos-option-3'));
    fireEvent.click(screen.getByTestId('filter-repos-save-set'));
    expect(screen.getByTestId('filter-repos-set-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('filter-repos-set-name'), {
      target: { value: '  Platform  ' },
    });
    fireEvent.click(screen.getByTestId('filter-repos-set-save'));
    expect(onSaveSet).toHaveBeenCalledWith('Platform', ['1', '3']);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['1', '3']));
  });

  it('says why a save failed and keeps the panel open', async () => {
    const onSaveSet = vi.fn().mockRejectedValue(new Error('Name too long'));
    render(
      <RepoPicker
        testId="filter-repos"
        options={OPTIONS}
        selected={['2']}
        onChange={vi.fn()}
        onSaveSet={onSaveSet}
      />,
    );
    open();
    fireEvent.click(screen.getByTestId('filter-repos-save-set'));
    fireEvent.change(screen.getByTestId('filter-repos-set-name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('filter-repos-set-save'));
    expect(await screen.findByTestId('filter-repos-set-error')).toHaveTextContent('Name too long');
    expect(screen.getByTestId('filter-repos-panel')).toBeInTheDocument();
  });

  it('offers no sets where the caller passes none (the agreement form)', () => {
    render(<RepoPicker options={OPTIONS} selected={['1']} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('repo-picker-button'));
    expect(screen.queryByTestId('repo-picker-sets')).toBeNull();
    expect(screen.queryByTestId('repo-picker-save-set')).toBeNull();
  });
});

describe('repository set helpers (W20-23)', () => {
  it('keeps every id while the options are still loading', () => {
    expect(applicableIds(SETS[1]!, [])).toEqual(['3', '42']);
  });

  it('compares selections as sets', () => {
    expect(sameIds(['1', '2'], ['2', '1'])).toBe(true);
    expect(sameIds(['1'], ['1', '2'])).toBe(false);
  });

  it('reads only my repository-set views from the views list, sorted by name', () => {
    const base = {
      is_shared: false,
      share_slug: null,
      is_default: false,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    };
    const items: ViewResponse[] = [
      { ...base, id: 1, name: 'Zeta', config: repoSetConfig([4, 5]) },
      { ...base, id: 2, name: 'Dashboard', config: { repo_ids: [4], window: '30d', layout: [] } },
      { ...base, id: 3, name: 'Alpha', config: repoSetConfig([6]) },
      { ...base, id: 4, name: 'Theirs', config: repoSetConfig([7]), is_owner: false },
    ];
    expect(repoSetsOf(items)).toEqual([
      { id: 3, name: 'Alpha', repoIds: ['6'] },
      { id: 1, name: 'Zeta', repoIds: ['4', '5'] },
    ]);
    expect(repoSetConfig([1, 2])).toEqual({
      repo_ids: [1, 2],
      window: '30d',
      layout: [],
      target: 'repos',
    });
  });
});
