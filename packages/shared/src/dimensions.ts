// The finding dimensions — ONE declaration (W9-17).
//
// This list used to live in three places: the CHECK constraint in
// db/schema/read/findings.ts, the API's facet in apps/api/src/routes/findings,
// and the web facet in apps/web's ALL_DIMENSIONS. They drifted, and the drift
// was invisible in the direction that matters: `slop` sat in the API and web
// copies from W9-03 while missing from the constraint, so the value was
// offered to users in two layers and could not be written in the third.
// Nothing failed until W9-16 tried to store one.
//
// DELIBERATELY DEPENDENCY-FREE, and its own export subpath. The web app cannot
// import `@repopulse/shared` — the package index pulls in postgres, pino and
// drizzle, none of which belong in a browser bundle — which is why urlState
// already has its own subpath. A constant with no imports can be shared by the
// schema, the API and the browser alike; anything heavier here would push the
// web facet back into a copy.

/**
 * Every dimension a finding may carry.
 *
 * Order is the facet order users see, not alphabetical: the four analysis
 * dimensions first (W6), then the scanner dimensions (W8/W9), then the
 * structural registers (W10). Adding one here is the whole change — but it
 * still needs a drizzle migration, because the CHECK constraint is DDL and a
 * running database does not learn about a new value by being asked nicely.
 * `dimensions.integration.test.ts` fails if you forget.
 */
export const FINDING_DIMENSIONS = [
  // Analysis (W6) — the four Tier-2 review dimensions.
  'code_health',
  'security',
  'performance',
  'test_coverage',
  // Scanners (W8/W9).
  'secrets',
  'dependency',
  'sast',
  'iac',
  'chain',
  'compound',
  'logging',
  'slop',
  // Structural registers (W10, D13).
  'knowledge',
  'dependency_health',
  'architecture',
  'test_gap',
] as const;

export type FindingDimension = (typeof FINDING_DIMENSIONS)[number];

/**
 * The dimension list as a SQL value list: `'a', 'b', 'c'`.
 *
 * The CHECK constraint cannot take a bound parameter — it is DDL, so drizzle
 * has to render the values inline — and this is the one place that rendering
 * happens. Quoting is asserted rather than trusted: every dimension matches
 * /^[a-z_]+$/ (there is a test), so there is no quote to escape and no value
 * that could carry SQL out of this string.
 */
export function dimensionSqlList(): string {
  return FINDING_DIMENSIONS.map((d) => `'${d}'`).join(', ');
}
