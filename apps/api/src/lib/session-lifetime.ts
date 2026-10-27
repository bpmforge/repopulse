// How long a sign-in lasts (FR-AUTH-2): a rolling idle timeout, renewed on
// every request, and an absolute cap. Both were hard-coded (15 minutes, 12
// hours) and documented nowhere; on the 2026-10-27 walkthrough a sign-in
// "dropped" after a quarter of an hour away and it took reading the source
// to learn why. Now set in deploy/.env and listed in CONFIG.md.

export const SESSION_IDLE_DEFAULT_MINUTES = 15;
export const SESSION_MAX_DEFAULT_HOURS = 12;

/** A whole number in [min, max], else the default — never NaN, never 0. */
function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export function sessionLifetime(env: Record<string, string | undefined>): {
  idleTimeoutMs: number;
  absoluteLifetimeMs: number;
} {
  const idleMinutes = bounded(env.SESSION_IDLE_MINUTES, SESSION_IDLE_DEFAULT_MINUTES, 5, 24 * 60);
  const maxHours = bounded(env.SESSION_MAX_HOURS, SESSION_MAX_DEFAULT_HOURS, 1, 30 * 24);
  return {
    idleTimeoutMs: idleMinutes * 60 * 1000,
    // An idle timeout longer than the cap would never fire; the cap wins.
    absoluteLifetimeMs: Math.max(maxHours * 60 * 60 * 1000, idleMinutes * 60 * 1000),
  };
}
