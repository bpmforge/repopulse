import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import {
  AI_PATTERN_LIMITS,
  DEFAULT_AI_AUTHORSHIP_PATTERNS,
  DEFAULT_BOT_LOGIN_GLOBS,
  DEFAULT_STALE_THRESHOLD_DAYS,
  resolveAiAuthorshipPatterns,
  type AiAuthorshipPatterns,
} from '@repopulse/metrics';
import { DEFAULT_WEIGHTS } from '@repopulse/insights';
import { DEFAULT_LICENSE_POLICY, LICENSE_CATEGORIES, policyFrom } from '@repopulse/security';

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

const patternList = z
  .array(z.string().trim().min(1).max(AI_PATTERN_LIMITS.maxLength))
  .max(AI_PATTERN_LIMITS.maxPerList);

/**
 * W18-20: the AI-authorship pattern list. Each list is optional on its own and
 * `[]` is honoured, the same unset-vs-empty rule as bot_login_globs: emptying
 * the branch list means "branch names say nothing here", not "use defaults".
 * Plain substrings, prefixes and single-`*` globs — never regexes, which an
 * admin could write to backtrack over every commit in a window.
 */
export const aiAuthorshipPatternsSchema = z
  .object({
    trailer_patterns: patternList.optional(),
    bot_logins: patternList.optional(),
    branch_prefixes: patternList.optional(),
  })
  .strict();

/**
 * W20-08 (UX_TODO FND-18): the license register's policy. The register has
 * read `licensePolicy` from these settings since W18-39, and nothing could
 * write it: the key was not in this schema, so PATCH refused it, and because
 * the stored blob is re-parsed through the schema on every save, any other
 * settings save would have dropped a policy written by hand. Every field is
 * optional, the same unset-vs-empty rule as the lists above.
 */
export const licensePolicySchema = z
  .object({
    /** Categories flagged in production scope (permissive, weak, strong, network copyleft, unknown). */
    flag_categories: z.array(z.enum(LICENSE_CATEGORIES as [string, ...string[]])).optional(),
    /** Flag a production dependency whose license could not be read. */
    flag_unknown: z.boolean().optional(),
    /** SPDX ids always allowed, whatever their category. */
    allow: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
    /** SPDX ids always flagged. */
    flag: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
  })
  .strict();

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
  ai_authorship_patterns: aiAuthorshipPatternsSchema.optional(),
  license_policy: licensePolicySchema.optional(),
  /**
   * W20-17 (UX_TODO INS-09): connections whose NEW repositories are tracked
   * automatically. Set by "Track all and auto-add new" in the repository
   * picker and turned off per connection; the nightly reconcile sweep lists
   * each one's repositories and tracks any it has not seen. Kept in settings
   * rather than a column so the choice needs no migration and is easy to move.
   */
  auto_add_connection_ids: z.array(z.number().int().positive()).max(200).optional(),
  /**
   * W20-19 (UX_TODO INS-09): repositories an admin removed and purged, per
   * connection id, by forge repository id. The nightly auto-add sweep skips
   * them, or "auto-add new" would track a purged repository again that night.
   * Tracking one again by hand in the picker still works.
   */
  auto_add_skip: z.record(z.string(), z.array(z.string().min(1)).max(2000)).optional(),
  /**
   * W20-19 (UX_TODO INS-69): connections set to "scheduled sync only". Their
   * repositories get no push webhook (the forge cannot reach this install, or
   * the org does not want hooks); the nightly reconcile sweep keeps them
   * current. Per connection in settings, like auto-add, so it needs no
   * migration.
   */
  scheduled_sync_only_connection_ids: z.array(z.number().int().positive()).max(200).optional(),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

/** Settings with defaults applied — what the metric engines actually consume. */
export interface EffectiveWorkspaceSettings {
  healthWeights: Record<string, number>;
  botLoginGlobs: readonly string[];
  stalePrDays: number;
  forgeBudget: { share: number; floor: number };
  aiAuthorshipPatterns: AiAuthorshipPatterns;
  /** What the license register applies (W20-08). */
  licensePolicy: {
    flagCategories: string[];
    flagUnknown: boolean;
    allow: string[];
    flag: string[];
  };
}

export const SETTINGS_DEFAULTS: EffectiveWorkspaceSettings = {
  healthWeights: DEFAULT_WEIGHTS,
  botLoginGlobs: DEFAULT_BOT_LOGIN_GLOBS,
  stalePrDays: DEFAULT_STALE_THRESHOLD_DAYS,
  // FORGE_PROVIDER §3: one workspace in v1, so it may spend the whole budget;
  // the floor mirrors the budgeted client's own reserve.
  forgeBudget: { share: 1, floor: 100 },
  aiAuthorshipPatterns: DEFAULT_AI_AUTHORSHIP_PATTERNS,
  licensePolicy: {
    flagCategories: [...DEFAULT_LICENSE_POLICY.flagCategories],
    flagUnknown: DEFAULT_LICENSE_POLICY.flagUnknown,
    allow: [...DEFAULT_LICENSE_POLICY.allow],
    flag: [...DEFAULT_LICENSE_POLICY.flag],
  },
};

export function applyDefaults(stored: WorkspaceSettings): EffectiveWorkspaceSettings {
  return {
    healthWeights: stored.health_weights ?? SETTINGS_DEFAULTS.healthWeights,
    // `??` NOT `||` — `[]` is falsy-adjacent thinking waiting to happen, and an
    // admin who empties the bot list must not silently get the defaults back.
    botLoginGlobs: stored.bot_login_globs ?? SETTINGS_DEFAULTS.botLoginGlobs,
    stalePrDays: stored.stale_pr_days ?? SETTINGS_DEFAULTS.stalePrDays,
    forgeBudget: stored.forge_budget ?? SETTINGS_DEFAULTS.forgeBudget,
    // The same resolver the report and the org tile use, so the screen can
    // never show a list the classifier is not actually applying.
    aiAuthorshipPatterns: resolveAiAuthorshipPatterns({
      ai_authorship_patterns: stored.ai_authorship_patterns,
    }),
    // The register's own reader, so this screen shows the policy it applies.
    licensePolicy: (() => {
      const p = policyFrom(stored as Record<string, unknown>);
      return {
        flagCategories: [...(p.flagCategories ?? [])],
        flagUnknown: p.flagUnknown,
        allow: [...p.allow],
        flag: [...p.flag],
      };
    })(),
  };
}

/**
 * W20-14: carry the legacy hand-written `licensePolicy` (camel case, read by the
 * register since W18-39) over to `license_policy`. Before this, the camel key
 * was stripped by the schema parse on the next settings save, so any save (a
 * stale-days edit) silently dropped a policy the register was applying.
 *
 * Only when no `license_policy` exists yet, and only when the converted object
 * passes the schema; an unconvertible legacy value is left untouched so it is
 * neither lost nor half-applied. Pure: returns a new object.
 */
export function migrateLegacySettings(raw: Record<string, unknown>): Record<string, unknown> {
  const legacy = raw['licensePolicy'];
  if (raw['license_policy'] !== undefined) return raw;
  if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) return raw;
  const l = legacy as Record<string, unknown>;
  const candidate: Record<string, unknown> = {};
  if (l['flagCategories'] !== undefined) candidate['flag_categories'] = l['flagCategories'];
  if (l['flagUnknown'] !== undefined) candidate['flag_unknown'] = l['flagUnknown'];
  if (l['allow'] !== undefined) candidate['allow'] = l['allow'];
  if (l['flag'] !== undefined) candidate['flag'] = l['flag'];
  const parsed = licensePolicySchema.safeParse(candidate);
  if (!parsed.success) return raw;
  const next: Record<string, unknown> = { ...raw, license_policy: parsed.data };
  delete next['licensePolicy'];
  return next;
}

/**
 * The keys of a stored blob that the settings schema does not own (planned LLM
 * knobs, an unconvertible legacy key). A PATCH keeps these verbatim.
 */
export function unknownSettingsKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(Object.keys(workspaceSettingsSchema.shape));
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !known.has(k)));
}

/**
 * Read one workspace's settings. A row whose jsonb fails validation (hand-edited
 * SQL, a downgrade) yields the defaults rather than throwing: a malformed
 * setting must not take the dashboard down, and the admin screen shows what is
 * actually in effect.
 *
 * `raw` is the stored jsonb (legacy keys migrated) INCLUDING keys this schema
 * does not know, so a PATCH can merge over it without deleting them.
 */
export async function readWorkspaceSettings(
  db: Database,
  workspaceId: number,
): Promise<{
  stored: WorkspaceSettings;
  effective: EffectiveWorkspaceSettings;
  raw: Record<string, unknown>;
}> {
  const [row] = await db
    .select({ settings: core.workspaces.settings })
    .from(core.workspaces)
    .where(eq(core.workspaces.id, workspaceId))
    .limit(1);

  const source: unknown = row?.settings;
  const raw =
    source !== null && typeof source === 'object' && !Array.isArray(source)
      ? migrateLegacySettings(source as Record<string, unknown>)
      : {};
  const parsed = workspaceSettingsSchema.safeParse(raw);
  const stored = parsed.success ? parsed.data : {};
  return { stored, effective: applyDefaults(stored), raw };
}

type ConnectionListKey = 'auto_add_connection_ids' | 'scheduled_sync_only_connection_ids';

/**
 * Add or remove one connection id in a per-connection settings list.
 * Read-modify-write of the one key, keeping every other key (known or not) as
 * stored. Returns the list now in effect.
 */
async function setConnectionFlag(
  db: Database,
  workspaceId: number,
  key: ConnectionListKey,
  connectionId: number,
  enabled: boolean,
): Promise<number[]> {
  const { raw, stored } = await readWorkspaceSettings(db, workspaceId);
  const current = new Set(stored[key] ?? []);
  if (enabled) current.add(connectionId);
  else current.delete(connectionId);
  const next = [...current].sort((a, b) => a - b);
  await db
    .update(core.workspaces)
    .set({ settings: { ...raw, [key]: next } })
    .where(eq(core.workspaces.id, workspaceId));
  return next;
}

/**
 * Turn "auto-add new repositories" on or off for one connection (W20-17,
 * UX_TODO INS-09). Returns the list now in effect.
 */
export function setConnectionAutoAdd(
  db: Database,
  workspaceId: number,
  connectionId: number,
  enabled: boolean,
): Promise<number[]> {
  return setConnectionFlag(db, workspaceId, 'auto_add_connection_ids', connectionId, enabled);
}

/**
 * Turn "scheduled sync only" (no webhooks) on or off for one connection
 * (W20-19, UX_TODO INS-69). Returns the list now in effect.
 */
export function setConnectionScheduledOnly(
  db: Database,
  workspaceId: number,
  connectionId: number,
  enabled: boolean,
): Promise<number[]> {
  return setConnectionFlag(
    db,
    workspaceId,
    'scheduled_sync_only_connection_ids',
    connectionId,
    enabled,
  );
}

/** True when this connection registers no webhooks (W20-19, UX_TODO INS-69). */
export function isScheduledOnly(stored: WorkspaceSettings, connectionId: number): boolean {
  return (stored.scheduled_sync_only_connection_ids ?? []).includes(connectionId);
}

/**
 * Remember that a purged repository must not be auto-added again (W20-19,
 * UX_TODO INS-09).
 */
export async function skipAutoAdd(
  db: Database,
  workspaceId: number,
  connectionId: number,
  forgeRepoId: string,
): Promise<void> {
  const { raw, stored } = await readWorkspaceSettings(db, workspaceId);
  const skip = { ...(stored.auto_add_skip ?? {}) };
  const key = String(connectionId);
  const list = new Set(skip[key] ?? []);
  list.add(forgeRepoId);
  skip[key] = [...list].slice(-2000);
  await db
    .update(core.workspaces)
    .set({ settings: { ...raw, auto_add_skip: skip } })
    .where(eq(core.workspaces.id, workspaceId));
}
