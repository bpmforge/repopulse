import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { DEFAULT_BOT_LOGIN_GLOBS, DEFAULT_STALE_THRESHOLD_DAYS } from '@repopulse/metrics';
import { DEFAULT_WEIGHTS } from '@repopulse/insights';

// Workspace settings (W4-09, DATABASE.md workspaces.settings, API_DESIGN.md §2
// "admin"). One jsonb column, read by the admin route AND by the snapshot
// worker, which is why this lives in lib/ rather than under routes/.
//
// EVERY FIELD IS OPTIONAL, and that is load-bearing rather than lazy typing.
// "unset" and "set to an empty/zero value" are different states here:
// `bot_login_globs: []` means an admin deliberately turned bot exclusion OFF,
// while an absent key means "use METRICS.md §0's list". Collapsing the two — by
// defaulting the column to `[]` — is exactly the bug this ticket found in the
// snapshot processor, where a literal `botGlobs: []` had silently disabled bot
// exclusion for every metric computed from real ingestion.

/**
 * Health-score weights. Keys match `buildHealthSubScores`'s lookups EXACTLY
 * (camelCase): a mismatch would not error, it would fall through to
 * DEFAULT_WEIGHTS on every key and an admin's edit would do nothing at all.
 */
export const healthWeightsSchema = z
  .object({
    activity: z.number().min(0).max(1),
    reviewHygiene: z.number().min(0).max(1),
    ciHealth: z.number().min(0).max(1),
    delivery: z.number().min(0).max(1),
  })
  // METRICS.md §3: the four Tier-1 sub-scores are the whole of the v1 score and
  // their weights sum to 1.00. The score function renormalizes by the weight of
  // the PRESENT sub-scores, so a set summing to 4.0 would produce identical
  // numbers — the check is not arithmetic necessity, it is so the stored config
  // means what §3's table says it means when a human reads it back.
  //
  // NOT validated here: the v1.x `security` (+0.20) and W10 `supplyChain`
  // (+0.10) rows. §3 adds those ON TOP and renormalizes, so they do not belong
  // in a sum-to-one check, and neither sub-score exists to be weighted yet.
  .refine((w) => Math.abs(w.activity + w.reviewHygiene + w.ciHealth + w.delivery - 1) < 1e-9, {
    message: 'health weights must sum to 1.00 (METRICS.md §3)',
  });

export const workspaceSettingsSchema = z.object({
  health_weights: healthWeightsSchema.optional(),
  /** Absent = METRICS.md §0 defaults. `[]` = bot exclusion deliberately off. */
  bot_login_globs: z.array(z.string().min(1)).optional(),
  /** FR-METRICS-8. Absent = 7. */
  stale_pr_days: z.number().int().min(1).max(365).optional(),
  /**
   * FR-FORGE-3. `share` is this workspace's slice of the connection's hourly
   * budget; `floor` is the reserve the client refuses to spend below.
   */
  forge_budget: z
    .object({
      share: z.number().min(0).max(1),
      floor: z.number().int().min(0),
    })
    .optional(),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

/** Settings with defaults applied — what the metric engines actually consume. */
export interface EffectiveWorkspaceSettings {
  healthWeights: Record<string, number>;
  botLoginGlobs: readonly string[];
  stalePrDays: number;
  forgeBudget: { share: number; floor: number };
}

export const SETTINGS_DEFAULTS: EffectiveWorkspaceSettings = {
  healthWeights: DEFAULT_WEIGHTS,
  botLoginGlobs: DEFAULT_BOT_LOGIN_GLOBS,
  stalePrDays: DEFAULT_STALE_THRESHOLD_DAYS,
  // FORGE_PROVIDER §3: one workspace in v1, so it may spend the whole budget;
  // the floor mirrors the budgeted client's own reserve.
  forgeBudget: { share: 1, floor: 100 },
};

export function applyDefaults(stored: WorkspaceSettings): EffectiveWorkspaceSettings {
  return {
    healthWeights: stored.health_weights ?? SETTINGS_DEFAULTS.healthWeights,
    // `??` NOT `||` — `[]` is falsy-adjacent thinking waiting to happen, and an
    // admin who empties the bot list must not silently get the defaults back.
    botLoginGlobs: stored.bot_login_globs ?? SETTINGS_DEFAULTS.botLoginGlobs,
    stalePrDays: stored.stale_pr_days ?? SETTINGS_DEFAULTS.stalePrDays,
    forgeBudget: stored.forge_budget ?? SETTINGS_DEFAULTS.forgeBudget,
  };
}

/**
 * Read one workspace's settings. A row whose jsonb fails validation (hand-edited
 * SQL, a downgrade) yields the defaults rather than throwing: a malformed
 * setting must not take the dashboard down, and the admin screen shows what is
 * actually in effect.
 */
export async function readWorkspaceSettings(
  db: Database,
  workspaceId: number,
): Promise<{ stored: WorkspaceSettings; effective: EffectiveWorkspaceSettings }> {
  const [row] = await db
    .select({ settings: core.workspaces.settings })
    .from(core.workspaces)
    .where(eq(core.workspaces.id, workspaceId))
    .limit(1);

  const parsed = workspaceSettingsSchema.safeParse(row?.settings ?? {});
  const stored = parsed.success ? parsed.data : {};
  return { stored, effective: applyDefaults(stored) };
}
