import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';

// Data stamps (W23-09, INCREMENTAL_SCAN_PLAN WP-R1).
//
// `scan_runs.data_version` is one string answering "what DATA did this answer
// stand on besides the commit": the rulepack, the scan image, the advisory
// database build. A runner stamps it when it starts and the probe recomputes it
// the same way without running, so `isUpToDate` can tell "same tree, same
// inputs" from "same tree, refreshed inputs". Both sides call the SAME function
// (one per scanner, beside its runner), which is what keeps them from drifting.
//
// This file is generic on purpose: it knows no scanner key. Anything that has
// to know what a scanner reads lives with the scanner.

/** A short, stable digest for a part too long or too noisy to print in a stamp. */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Joins named parts into one readable, order-independent stamp
 * (`image@localhost/repopulse/scan:dev rulepack@a.yaml,b.yaml`).
 *
 * `undefined` parts are omitted (an input that does not apply). A `null` part
 * means an input that APPLIES but cannot be read right now, and then the whole
 * stamp is null: a stamp built from half the evidence must not exist, because
 * "run" is the only honest answer when one input is unknown. No parts at all is
 * also null — nothing to stamp.
 */
export function dataStamp(parts: Record<string, string | null | undefined>): string | null {
  const entries = Object.entries(parts).filter(([, v]) => v !== undefined) as [
    string,
    string | null,
  ][];
  if (entries.length === 0 || entries.some(([, v]) => v === null)) return null;
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}@${v}`)
    .join(' ');
}

/**
 * The workspace's rule LIFECYCLE state, as one short digest (or null when it
 * cannot be read).
 *
 * Which findings a pattern scan stores, and whether each is shadow-only
 * ("experimental") or live, is decided at write time from `rule_registry`
 * (promote a rule from candidate to active and the same tree reports it
 * differently). That state is not in the commit, the tool versions or the
 * rulepack's file names, so a stamp without it would let a skip present the
 * pre-promotion answer as current. Cheap: one indexed select of two columns.
 */
export async function ruleStateStamp(db: Database, workspaceId: number): Promise<string | null> {
  try {
    const rows = await db
      .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
      .from(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, workspaceId));
    return shortHash(
      rows
        .map((r) => `${r.ruleId}:${r.status}`)
        .sort()
        .join(','),
    );
  } catch {
    return null;
  }
}
