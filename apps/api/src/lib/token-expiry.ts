// Forge token expiry warnings (W20-25, UX_TODO ADM-50; W20_DECISIONS_2 row 4).
//
// A personal token that expires stops ingestion with nothing said beforehand.
// The expiry is read from the forge at connect time; this module is the one
// place that decides when it is worth a warning, so the Connections table, the
// admin banner and the inbox can never disagree about it.

/** Days before expiry that the warning starts (the decision: 14). */
export const TOKEN_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TokenExpiryState = 'expired' | 'expiring' | 'ok' | 'unknown';

/** Where one connection's token stands today. `unknown` = the forge did not say. */
export function tokenExpiryState(expiresAt: Date | null, now: Date = new Date()): TokenExpiryState {
  if (expiresAt === null) return 'unknown';
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  if (left <= TOKEN_EXPIRY_WARNING_DAYS * DAY_MS) return 'expiring';
  return 'ok';
}

/** When the warning for this expiry began: the inbox counts it as new after that. */
export function warningStartsAt(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - TOKEN_EXPIRY_WARNING_DAYS * DAY_MS);
}

/** Whole days left, rounded down; 0 on the last day, negative once expired. */
export function daysLeft(expiresAt: Date, now: Date = new Date()): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
}
