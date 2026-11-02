import { z } from 'zod';

// HealthRule schema + pack validation (W9-07, CODE_HEALTH_SUITE.md §8.1, FR-CH-8).
//
// TWO FIELDS ARE NON-NEGOTIABLE and the validator exists to enforce them:
// PROVENANCE (where the rule came from, under what licence) and FIXTURES (one
// file that must trigger it, one that must not). A rule missing either cannot
// merge.
//
// Provenance, because a rule with no recorded source is a rule nobody can
// licence-check later — and this product already refuses Semgrep registry rules
// on exactly those grounds. Fixtures, because a rule with no clean fixture has
// never been shown NOT to fire, and the failure mode of a static analyser is
// not "misses things", it is "cries wolf until people turn it off".
//
// The rule CONTENT stays in versioned rulepack assets. The database holds
// per-workspace lifecycle state only: a rule whose text lived in a row could be
// edited without a review, a diff or a version.

export const RULE_DOMAINS = ['slop', 'logging', 'perf', 'correctness', 'framework'] as const;
export const RULE_LAYERS = ['pack', 'hybrid', 'llm'] as const;
export const RULE_STATUSES = ['proposed', 'candidate', 'active', 'deprecated'] as const;

/**
 * Licences an imported pack may carry (§8.3 deny-by-default).
 *
 * An unlisted licence is REFUSED rather than flagged for review: a rule that
 * runs while someone decides is a rule that has already run.
 */
export const ALLOWED_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  // Ours before the 2026-10-31 relicensing to Apache-2.0 (W22-13). New rows say
  // 'Apache-2.0'; this value stays allowed because rules stored by earlier
  // installs still carry it, and the Rules page shows it as Apache-2.0.
  'UNLICENSED-REPOPULSE',
] as const;

export const provenanceSchema = z.object({
  /** 'experts:R-01' | 'field_lesson' | 'external:{repo}' | 'llm_draft'. */
  source: z.string().min(3),
  license: z.string().min(1),
  author: z.string().min(1),
  date: z.string().min(4),
});

export const healthRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+\.[a-z0-9-]+$/, 'id must be {domain}.{slug}'),
  domain: z.enum(RULE_DOMAINS),
  layer: z.enum(RULE_LAYERS),
  languages: z.array(z.string().min(1)).min(1),
  severity: z.number().int().min(1).max(5),
  status: z.enum(RULE_STATUSES),
  provenance: provenanceSchema,
  engineRule: z.string().optional(),
  checklistItem: z.string().optional(),
  fixtures: z.object({
    trigger: z.array(z.string().min(1)).min(1),
    clean: z.array(z.string().min(1)).min(1),
  }),
});

export type HealthRule = z.infer<typeof healthRuleSchema>;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export class RuleValidationError extends Error {
  constructor(
    readonly ruleId: string,
    message: string,
  ) {
    super(`rule "${ruleId}": ${message}`);
    this.name = 'RuleValidationError';
  }
}

export function isAllowedLicense(license: string): boolean {
  return (ALLOWED_LICENSES as readonly string[]).includes(license);
}

export interface ValidateOptions {
  /** Import path: licence is enforced. Our own packs are ours by definition. */
  enforceLicense?: boolean;
}

/**
 * Validates one rule. Throws with the reason — never returns a partial rule.
 *
 * A validator that returned "valid except…" would let a rule with no clean
 * fixture into a pack while someone meant to come back to it.
 */
export function validateHealthRule(input: unknown, opts: ValidateOptions = {}): HealthRule {
  const parsed = healthRuleSchema.safeParse(input);
  if (!parsed.success) {
    const id = (input as { id?: unknown })?.id;
    throw new RuleValidationError(
      typeof id === 'string' ? id : '(no id)',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const rule = parsed.data;

  // A pack/hybrid rule with no engine rule is a rule nothing can run; an
  // llm/hybrid rule with no checklist item is a question nobody asks.
  if ((rule.layer === 'pack' || rule.layer === 'hybrid') && !rule.engineRule) {
    throw new RuleValidationError(rule.id, 'a pack or hybrid rule needs an engineRule path');
  }
  if ((rule.layer === 'llm' || rule.layer === 'hybrid') && !rule.checklistItem) {
    throw new RuleValidationError(rule.id, 'an llm or hybrid rule needs a checklistItem');
  }
  if (opts.enforceLicense && !isAllowedLicense(rule.provenance.license)) {
    throw new RuleValidationError(
      rule.id,
      `licence "${rule.provenance.license}" is not on the import allowlist (${ALLOWED_LICENSES.join(', ')}) — refused rather than queued for review, because a rule that runs while someone decides has already run`,
    );
  }
  return rule;
}

/** Validates a whole pack manifest; reports EVERY failure, not the first. */
export function validateRulePack(
  rules: readonly unknown[],
  opts: ValidateOptions = {},
): { rules: HealthRule[]; errors: string[] } {
  const out: HealthRule[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const raw of rules) {
    try {
      const rule = validateHealthRule(raw, opts);
      if (seen.has(rule.id)) {
        errors.push(`duplicate rule id "${rule.id}"`);
        continue;
      }
      seen.add(rule.id);
      out.push(rule);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { rules: out, errors };
}
