import { z } from 'zod';

// Single source of truth for RepoPulse URL view-state (DASHBOARD.md §1,
// FR-WEB-2/5). Pure zod + string helpers, zero server/DB coupling — this is
// the one shared module apps/web is allowed to import at RUNTIME (via the
// `@repopulse/shared/url-state` subpath; the barrel stays type-only per
// ARCHITECTURE §3). The API validates the same query params against its own
// per-route schemas; keeping the contract here means both sides agree on the
// wire shape and every screen state is a shareable, bookmarkable URL.
//
// Rule (DASHBOARD §1): defaults are OMITTED from the URL to keep links clean;
// parsing is lenient (unknown/garbage falls back to defaults) so a hand-edited
// or stale URL never white-screens the app.

/** Time window: a preset, or a custom ISO-date range `start..end`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const WINDOW_PRESETS = ['7d', '30d', '90d', '365d'] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];
export const DEFAULT_WINDOW: WindowPreset = '30d';

const windowSchema = z
  .string()
  .refine(
    (v) =>
      (WINDOW_PRESETS as readonly string[]).includes(v) ||
      (v.includes('..') &&
        v.split('..').length === 2 &&
        v.split('..').every((d) => ISO_DATE.test(d))),
    { message: 'window must be 7d|30d|90d|365d or an ISO `start..end` range' },
  );

/** A custom `start..end` window, or null for a preset or garbage. */
export function customRange(window: string): { start: string; end: string } | null {
  if ((WINDOW_PRESETS as readonly string[]).includes(window)) return null;
  const parts = window.split('..');
  if (parts.length !== 2 || !parts.every((d) => ISO_DATE.test(d))) return null;
  return { start: parts[0]!, end: parts[1]! };
}

/**
 * The preset whose snapshots a window is read from (W20-09, UX_TODO DSH-56).
 *
 * Metrics are snapshotted per PRESET window (METRICS.md FR-METRICS-13), so a
 * custom `start..end` has no numbers of its own yet, and every metrics
 * endpoint answered one with a 400. Until per-range computation exists, a
 * range is read through the smallest preset at least as long as it, and the
 * window control says so; a preset passes through unchanged.
 */
export function presetCovering(window: string): WindowPreset {
  if ((WINDOW_PRESETS as readonly string[]).includes(window)) return window as WindowPreset;
  const range = customRange(window);
  if (!range) return DEFAULT_WINDOW;
  const days = Math.max(
    1,
    Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1,
  );
  return WINDOW_PRESETS.find((p) => Number(p.replace('d', '')) >= days) ?? '365d';
}

export const globalSearchSchema = z.object({
  window: windowSchema.default(DEFAULT_WINDOW),
  // csv of repo ids, or the sentinel 'all' (default → omitted).
  repos: z.string().min(1).optional(),
  // a github login scoping PR/review widgets.
  person: z.string().min(1).optional(),
});
export type GlobalSearch = z.infer<typeof globalSearchSchema>;

export const findingsSearchSchema = globalSearchSchema.extend({
  dim: z.string().min(1).optional(),
  sev: z.string().min(1).optional(),
  conf: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  sort: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
});
export type FindingsSearch = z.infer<typeof findingsSearchSchema>;

export const tableSearchSchema = z.object({
  // `${col}:asc|desc`
  sort: z
    .string()
    .regex(/^[a-zA-Z0-9_]+:(asc|desc)$/)
    .optional(),
  cursor: z.string().min(1).optional(),
  density: z.enum(['c', 'm']).optional(),
});
export type TableSearch = z.infer<typeof tableSearchSchema>;

/**
 * Parse an unknown URL search record into a valid GlobalSearch. Lenient: any
 * field that fails validation is dropped and the default applies (a bad
 * `?window=` never breaks the page — FR-WEB-2 resilience).
 */
export function parseGlobalSearch(input: Record<string, unknown>): GlobalSearch {
  const cleaned: Record<string, unknown> = {};
  if (windowSchema.safeParse(input.window).success) cleaned.window = input.window;
  if (typeof input.repos === 'string' && input.repos.length > 0) cleaned.repos = input.repos;
  if (typeof input.person === 'string' && input.person.length > 0) cleaned.person = input.person;
  return globalSearchSchema.parse(cleaned);
}

/**
 * Serialize a GlobalSearch back to a URL search record with DEFAULTS OMITTED
 * (clean links; DASHBOARD §1). The inverse of parseGlobalSearch for any
 * non-default state: parse(serialize(s)) === s.
 */
export function serializeGlobalSearch(search: GlobalSearch): Record<string, string> {
  const out: Record<string, string> = {};
  if (search.window !== DEFAULT_WINDOW) out.window = search.window;
  if (search.repos && search.repos !== 'all') out.repos = search.repos;
  if (search.person) out.person = search.person;
  return out;
}
