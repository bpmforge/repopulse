// The health ramp's bands — ONE declaration (W20-05, UX_TODO DSH-10).
//
// The Overview carried two band systems on one screen: the health badges used
// UX_SPEC §2.1's three bands (good ≥75, watch 50–74, attend <50) while Needs
// attention filtered on the score letter's A–E cut-offs (C = 50–69, B = 70–84).
// A repository at 72 was "watch" on the grid and missing from Needs attention,
// so the two cards on the same page disagreed about the same number.
//
// Dependency-free and its own export subpath for the same reason as
// dimensions.ts: the web badge and the API's attention feed both read it, and
// the browser cannot import the package index.

export type HealthBand = 'good' | 'watch' | 'attend';

/** At or above this a repository is healthy and asks for nothing. */
export const HEALTH_GOOD_MIN = 75;
/** Below this it needs attention rather than watching. */
export const HEALTH_WATCH_MIN = 50;

export function healthBand(score: number): HealthBand {
  if (score >= HEALTH_GOOD_MIN) return 'good';
  if (score >= HEALTH_WATCH_MIN) return 'watch';
  return 'attend';
}
