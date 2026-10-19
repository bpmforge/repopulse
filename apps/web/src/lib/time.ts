// Shared time wording (W20-14). System health, Sync and Reports each needed a
// "5 min ago"; one copy keeps them saying the same thing.

/** "just now", "5 min ago", "3 h ago", "2 d ago"; "never" for null. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * A timestamp in the viewer's local time zone, with the zone named
 * (W20-14, UX_TODO ADM-26): "19 Oct 2026, 14:03 BST". Report history showed a
 * bare UTC slice that read as local time.
 */
export function localDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
