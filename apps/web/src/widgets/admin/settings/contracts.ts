// Admin → Settings contracts (W4-09).
// Source of truth: apps/api/src/routes/admin/workspace/index.ts.

export interface HealthWeights {
  activity: number;
  reviewHygiene: number;
  ciHealth: number;
  delivery: number;
}

export interface EffectiveSettings {
  healthWeights: HealthWeights;
  botLoginGlobs: string[];
  stalePrDays: number;
  forgeBudget: { share: number; floor: number };
}

/** What an admin actually chose. An absent key means "never set" — see below. */
export interface StoredSettings {
  health_weights?: HealthWeights;
  bot_login_globs?: string[];
  stale_pr_days?: number;
  forge_budget?: { share: number; floor: number };
}

export interface WorkspaceSettingsResponse {
  stored: StoredSettings;
  effective: EffectiveSettings;
  defaults: EffectiveSettings;
  /** Settings whose UI exists but whose engine does not (W6/W7). */
  pending?: string[];
}

export const WEIGHT_KEYS: { key: keyof HealthWeights; label: string }[] = [
  { key: 'activity', label: 'Activity' },
  { key: 'reviewHygiene', label: 'Review hygiene' },
  { key: 'ciHealth', label: 'CI health' },
  { key: 'delivery', label: 'Delivery' },
];

/**
 * METRICS.md §3: the four Tier-1 weights sum to 1.00. Checked in the browser so
 * the admin sees it before submitting; the API re-checks it, because a client
 * check is a courtesy and not a control.
 */
export function weightsSumOk(w: HealthWeights): boolean {
  return Math.abs(w.activity + w.reviewHygiene + w.ciHealth + w.delivery - 1) < 1e-9;
}

/**
 * Whether a field is showing a default rather than a chosen value. Driven by
 * key ABSENCE in `stored`, never by comparing against the default value: an
 * admin who deliberately types 7 has made a decision, and a screen that calls
 * it "default" is telling them their choice did not save.
 */
export function isDefaulted(stored: StoredSettings, key: keyof StoredSettings): boolean {
  return stored[key] === undefined;
}
