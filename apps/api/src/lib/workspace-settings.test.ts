import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_LOGIN_GLOBS, DEFAULT_STALE_THRESHOLD_DAYS } from '@repopulse/metrics';
import { DEFAULT_WEIGHTS } from '@repopulse/insights';
import {
  applyDefaults,
  healthWeightsSchema,
  workspaceSettingsSchema,
} from './workspace-settings.js';

// W4-09. These are the semantics the settings screen depends on, tested without
// a database because they are pure and because the distinction they encode is
// the one that already shipped as a bug once.

describe('workspace settings defaulting (W4-09)', () => {
  it('an unset bot list means METRICS.md §0 defaults', () => {
    expect(applyDefaults({}).botLoginGlobs).toEqual(DEFAULT_BOT_LOGIN_GLOBS);
  });

  // THE BUG THIS EXISTS TO PREVENT. processors.ts passed a literal
  // `botGlobs: []` meaning "no override"; isBotLogin does `globs.some(...)`, so
  // it actually meant "nothing is a bot" and bot exclusion had never run in
  // production. An empty list must therefore survive as an empty list — and
  // must NOT be reachable by accident.
  it('an explicitly emptied bot list stays empty — it does not fall back to defaults', () => {
    expect(applyDefaults({ bot_login_globs: [] }).botLoginGlobs).toEqual([]);
  });

  it('unset settings reproduce every documented default', () => {
    const eff = applyDefaults({});
    expect(eff.healthWeights).toEqual(DEFAULT_WEIGHTS);
    expect(eff.stalePrDays).toBe(DEFAULT_STALE_THRESHOLD_DAYS);
  });

  it('a stored value wins over the default', () => {
    expect(applyDefaults({ stale_pr_days: 21 }).stalePrDays).toBe(21);
  });
});

describe('health weight validation (METRICS.md §3)', () => {
  it('accepts the documented default weights', () => {
    expect(healthWeightsSchema.safeParse(DEFAULT_WEIGHTS).success).toBe(true);
  });

  it('rejects a set that does not sum to 1.00', () => {
    const res = healthWeightsSchema.safeParse({
      activity: 0.5,
      reviewHygiene: 0.5,
      ciHealth: 0.5,
      delivery: 0.5,
    });
    expect(res.success).toBe(false);
  });

  // The keys are the contract with buildHealthSubScores, which looks them up as
  // `weights.reviewHygiene ?? DEFAULT_WEIGHTS.reviewHygiene`. A snake_case key
  // would not error anywhere — it would fall through to the default on every
  // lookup and an admin's edit would silently do nothing.
  it('rejects snake_case keys rather than silently ignoring them', () => {
    const res = healthWeightsSchema.safeParse({
      activity: 0.2,
      review_hygiene: 0.3,
      ci_health: 0.25,
      delivery: 0.25,
    });
    expect(res.success).toBe(false);
  });

  it('rejects a partial weight set — a missing key is not a zero weight', () => {
    expect(healthWeightsSchema.safeParse({ activity: 1 }).success).toBe(false);
  });
});

describe('settings schema', () => {
  it('accepts an empty object — every field is optional by design', () => {
    expect(workspaceSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a stale-N of zero: every PR would be stale the moment it opened', () => {
    expect(workspaceSettingsSchema.safeParse({ stale_pr_days: 0 }).success).toBe(false);
  });
});
