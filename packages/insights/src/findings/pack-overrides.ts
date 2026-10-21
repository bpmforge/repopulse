import { and, eq, inArray, sql } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import type { IncomingFinding } from './store.js';

// A shipped rule, overridden for one workspace (W20-21, UX_TODO FND-53).
//
// A rule from a shipped pack has no registry row: it runs as shipped. When one
// turns out to be noisy here, an admin can move it to SHADOW for this
// workspace: a registry row marked `provenance.source = 'pack_override'`. Its
// findings are then stamped experimental (kept and measured, left out of
// scores, banners, plans, reports and the default list), and a later
// deprecation of that row stops it raising anything at all. Deleting the row
// restores the rule as shipped.
//
// Applied here, in the one place every scanner's findings pass through, so no
// scanner has to know about overrides and none can forget to honour them.

/** The provenance source that marks a registry row as a workspace override of a shipped rule. */
export const PACK_OVERRIDE_SOURCE = 'pack_override';

/** Applies this workspace's overrides of shipped rules to a batch of findings. */
export async function applyPackOverrides(
  db: Database,
  workspaceId: number,
  findings: readonly IncomingFinding[],
): Promise<IncomingFinding[]> {
  const ruleIds = [
    ...new Set(findings.map((f) => f.ruleId).filter((r): r is string => typeof r === 'string')),
  ];
  if (ruleIds.length === 0) return [...findings];
  const rows = await db
    .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
    .from(security.ruleRegistry)
    .where(
      and(
        eq(security.ruleRegistry.workspaceId, workspaceId),
        inArray(security.ruleRegistry.ruleId, ruleIds),
        sql`${security.ruleRegistry.provenance} ->> 'source' = ${PACK_OVERRIDE_SOURCE}`,
      ),
    );
  if (rows.length === 0) return [...findings];
  const statusOf = new Map(rows.map((r) => [r.ruleId, r.status]));
  const out: IncomingFinding[] = [];
  for (const f of findings) {
    const status = f.ruleId ? statusOf.get(f.ruleId) : undefined;
    if (status === undefined || status === 'active') {
      out.push(f);
    } else if (status === 'deprecated') {
      continue;
    } else {
      out.push({ ...f, experimental: true });
    }
  }
  return out;
}
