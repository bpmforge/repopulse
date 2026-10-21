import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from '../components/table/DataTable.js';
import { csvField, csvFileName, toCsv } from './csv.js';

// W20-20 (UX_TODO DSH-71): tables and charts export what is on screen as CSV.

describe('csv helpers', () => {
  it('quotes commas, quotes and newlines, and defuses spreadsheet formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(-3)).toBe('-3');
    expect(csvField(null)).toBe('');
    expect(toCsv(['Week', 'Gross'], [['2026-W01', 12]])).toBe('Week,Gross\r\n2026-W01,12\r\n');
  });

  it('names the file after the table and the day', () => {
    expect(csvFileName('org hotspots!', new Date('2026-10-21T10:00:00Z'))).toBe(
      'org-hotspots-2026-10-21.csv',
    );
  });
});

describe('DataTable "Download CSV"', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exports the header and the rows as the reader sees them', async () => {
    let captured: Blob | undefined;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => {
        captured = b;
        return 'blob:x';
      },
      revokeObjectURL: () => undefined,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(
      <DataTable
        name="people"
        columns={[
          { id: 'name', header: 'Name', cell: (r: { name: string; n: number }) => <b>{r.name}</b> },
          { id: 'n', header: 'PRs', cell: (r) => r.n },
        ]}
        data={[
          { name: 'Ada, L.', n: 3 },
          { name: 'Grace', n: 5 },
        ]}
        getRowId={(r) => r.name}
      />,
    );
    fireEvent.click(screen.getByTestId('table-people-csv'));
    expect(click).toHaveBeenCalled();
    // jsdom's Blob has no text(); FileReader reads it.
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(captured!);
    });
    expect(text.replace(/^\uFEFF/, '')).toBe('Name,PRs\r\n"Ada, L.",3\r\nGrace,5\r\n');
    click.mockRestore();
  });

  it('offers nothing to export for an empty table', () => {
    render(<DataTable name="empty" columns={[]} data={[]} getRowId={() => 'x'} />);
    expect(screen.queryByTestId('table-empty-csv')).toBeNull();
  });
});
