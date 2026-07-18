// Opaque numeric-id cursor for GET /views (API_DESIGN.md §1/§4). Rows are
// ordered by id ascending; the cursor is just the last-seen id, base64url
// encoded so it stays an opaque string on the wire per the doc's example
// (`"b2Zmc2V0OjEwMA"`).
export function encodeCursor(lastId: number): string {
  return Buffer.from(String(lastId), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(decoded) && decoded > 0 ? decoded : null;
}
