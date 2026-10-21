// CSV export for tables and chart data (W20-20, UX_TODO DSH-71).
//
// A lead preparing retro slides, or an exec pasting numbers into a board deck,
// had to retype them from the screen. Every DataTable and every chart's "view
// as table" now offers "Download CSV" of exactly what is on screen.

export type CsvCell = string | number | boolean | null | undefined;

/** RFC 4180: quote a field holding a comma, quote, CR or LF; double the quotes. */
export function csvField(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // A leading =, +, - or @ makes a spreadsheet evaluate the cell as a formula
  // (CSV injection). Repository paths and PR titles are user-controlled.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** The text of a rendered table, header first — what the reader sees. */
export function tableToRows(table: HTMLTableElement): { header: string[]; rows: string[][] } {
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const header = [...table.querySelectorAll('thead th')].map(text);
  const rows = [...table.querySelectorAll('tbody tr')]
    .filter((tr) => tr.getAttribute('data-testid') !== 'row-skeleton')
    .map((tr) => [...tr.querySelectorAll('th, td')].map(text));
  return { header, rows };
}

/** A safe file name: letters, digits, dash; dated so two exports do not collide. */
export function csvFileName(name: string, now: Date = new Date()): string {
  const base = name.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'table';
  return `${base}-${now.toISOString().slice(0, 10)}.csv`;
}

export function downloadCsv(fileName: string, csv: string): void {
  // The BOM makes Excel read UTF-8 (names with accents, the en dash in ranges).
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
