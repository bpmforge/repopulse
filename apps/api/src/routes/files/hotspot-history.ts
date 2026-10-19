// File page hotspot history (W20-13). M2's scalar is the repo's top file, so
// the per-file points come from each snapshot's `dims.files` list.

/**
 * One file's points from M2 snapshots, newest first (as read). A snapshot whose
 * `dims.files` does not list the path contributes nothing (W20-13).
 */
export function fileHotspotHistory(
  rows: readonly { computedAt: Date | string; dims: Record<string, unknown> }[],
  path: string,
): { computed_at: string; score: number }[] {
  const out: { computed_at: string; score: number }[] = [];
  for (const row of rows) {
    const files = row.dims['files'];
    if (!Array.isArray(files)) continue;
    const hit = files.find(
      (f): f is { path: string; score: number } =>
        typeof f === 'object' &&
        f !== null &&
        (f as { path?: unknown }).path === path &&
        typeof (f as { score?: unknown }).score === 'number',
    );
    if (!hit) continue;
    const at = row.computedAt instanceof Date ? row.computedAt.toISOString() : row.computedAt;
    out.push({ computed_at: at, score: hit.score });
  }
  return out;
}
