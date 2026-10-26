import { and, eq, inArray } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import { RULE_STATUSES, type RuleStatus } from './schema.js';
import { isStarterRule } from './starter-set.js';

// Shadow mode for rules that ship in a PACK FILE (W18-13, CODE_HEALTH_SUITE.md
// §8.2).
//
// The in-process anti_slop rules always knew their lifecycle; the YAML packs
// did not, so a new semgrep rule went straight to scoring the day it merged —
// exactly the "add it and see" the lifecycle exists to stop. A rule author now
// marks a new rule `metadata.lifecycle: candidate` in its YAML, the parser
// carries that through as the rule's SHIPPED status, and this module combines
// it with the workspace's rule_registry row, which always wins: an admin's
// promotion or deprecation is a decision about this workspace, the YAML line
// is only the default.

/** What the rule file says. Rules without the line predate the lifecycle and stay live. */
export type ShippedStatus = 'candidate' | 'active';

/** What a scan does with the rule in this workspace. */
export type EffectiveStatus = 'candidate' | 'active' | 'deprecated';

const KNOWN = new Set<string>(RULE_STATUSES);

/**
 * Reads `metadata.lifecycle` off a rule's metadata. Anything but `candidate` is live.
 *
 * W21-04: a rule in the starter set (starter-set.ts) ships live whatever its
 * file says, because its precision was measured on independent benchmarks.
 * The registry row still wins over this default (effectiveStatus).
 */
export function shippedStatusOf(metadata: Record<string, unknown>, ruleId?: string): ShippedStatus {
  if (ruleId !== undefined && isStarterRule(ruleId)) return 'active';
  return metadata['lifecycle'] === 'candidate' ? 'candidate' : 'active';
}

/**
 * A rule's registry status overrides its shipped default.
 *
 * A row in `proposed` or `candidate` still runs in shadow rather than not at
 * all: a row exists because someone is evaluating the rule, and evaluation
 * needs findings to look at.
 */
export function effectiveStatus(
  shipped: ShippedStatus,
  row: RuleStatus | undefined,
): EffectiveStatus {
  if (row === 'active' || row === 'deprecated') return row;
  if (row === 'proposed' || row === 'candidate') return 'candidate';
  return shipped;
}

/** This workspace's registry rows for the given rules, in one query. */
export async function registryStatuses(
  db: Database,
  workspaceId: number,
  ruleIds: readonly string[],
): Promise<Map<string, RuleStatus>> {
  const ids = [...new Set(ruleIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
    .from(security.ruleRegistry)
    .where(
      and(
        eq(security.ruleRegistry.workspaceId, workspaceId),
        inArray(security.ruleRegistry.ruleId, ids),
      ),
    );
  const out = new Map<string, RuleStatus>();
  for (const row of rows) {
    // The column has a CHECK constraint, so this only guards against a schema
    // drifting ahead of this code; an unknown status is treated as no row.
    if (KNOWN.has(row.status)) out.set(row.ruleId, row.status as RuleStatus);
  }
  return out;
}

export interface LifecycleAware {
  ruleId: string;
  shippedStatus: ShippedStatus;
}

/**
 * Drops findings of deprecated rules and states `experimental` where the rule
 * has a lifecycle opinion.
 *
 * `experimental` is left UNSET for a live rule nobody has registered: the
 * finding store reads "absent" as "keep the row's flag", and every pack rule
 * that predates this module is in that state. Stating `false` for them would
 * be harmless today and a silent override the day someone shadows one by hand.
 *
 * A starter-set rule (W21-04) IS stated: it ran in shadow before the starter
 * set existed, so a workspace may hold its findings stamped experimental, and
 * leaving the flag unset would keep them out of every count for good.
 */
export function applyShadow<F extends LifecycleAware>(
  findings: readonly F[],
  registry: ReadonlyMap<string, RuleStatus>,
): Array<F & { experimental?: boolean }> {
  const out: Array<F & { experimental?: boolean }> = [];
  for (const finding of findings) {
    const row = registry.get(finding.ruleId);
    const status = effectiveStatus(finding.shippedStatus, row);
    if (status === 'deprecated') continue;
    if (row === undefined && finding.shippedStatus === 'active' && !isStarterRule(finding.ruleId)) {
      out.push(finding);
      continue;
    }
    out.push({ ...finding, experimental: status !== 'active' });
  }
  return out;
}

/** `applyShadow` with the registry read for the rules the findings came from. */
export async function shadowFindings<F extends LifecycleAware>(
  db: Database,
  workspaceId: number,
  findings: readonly F[],
): Promise<Array<F & { experimental?: boolean }>> {
  const registry = await registryStatuses(
    db,
    workspaceId,
    findings.map((f) => f.ruleId),
  );
  return applyShadow(findings, registry);
}
