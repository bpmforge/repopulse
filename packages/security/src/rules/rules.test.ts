import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LICENSES,
  isAllowedLicense,
  RuleValidationError,
  validateHealthRule,
  validateRulePack,
} from './schema.js';
import {
  canTransition,
  countsTowardsScores,
  demotionFlag,
  fpRate,
  isShadow,
  PROMOTION_GATE,
  promotionVerdict,
} from './lifecycle.js';
import { acceptDraft, buildDraftPrompt, clusterDismissals } from './intake.js';

// Rule lifecycle and intake (W9-07, CODE_HEALTH_SUITE.md §8, FR-CH-8/9).

const validRule = {
  id: 'slop.empty-catch',
  domain: 'slop',
  layer: 'pack',
  languages: ['javascript', 'typescript'],
  severity: 2,
  status: 'proposed',
  provenance: {
    source: 'experts:R-01',
    license: 'UNLICENSED-REPOPULSE',
    author: 'brad',
    date: '2026-08-19',
  },
  engineRule: 'rulepacks/code-health/anti-slop.v1.yaml',
  fixtures: { trigger: ['fixtures/triggering/slop.js'], clean: ['fixtures/clean/tidy.js'] },
};

describe('a rule without provenance or fixtures does not exist', () => {
  it('accepts a complete rule', () => {
    expect(validateHealthRule(validRule).id).toBe('slop.empty-catch');
  });

  it('REJECTS a rule with no provenance', () => {
    // A rule with no recorded source cannot be licence-checked later, and this
    // product already refuses registry rules on exactly those grounds.
    const { provenance, ...noProvenance } = validRule;
    void provenance;
    expect(() => validateHealthRule(noProvenance)).toThrow(RuleValidationError);
  });

  it('REJECTS a rule with no CLEAN fixture', () => {
    // The failure mode of a static analyser is not "misses things", it is
    // "cries wolf until people turn it off" — and a rule with no clean fixture
    // has never been shown not to fire.
    expect(() =>
      validateHealthRule({ ...validRule, fixtures: { trigger: ['a.js'], clean: [] } }),
    ).toThrow(/clean/);
  });

  it('REJECTS a pack rule with nothing to run', () => {
    const { engineRule, ...noEngine } = validRule;
    void engineRule;
    expect(() => validateHealthRule(noEngine)).toThrow(/engineRule/);
  });

  it('REJECTS an llm rule with no checklist item', () => {
    expect(() => validateHealthRule({ ...validRule, layer: 'llm', engineRule: undefined })).toThrow(
      /checklistItem/,
    );
  });

  it('reports EVERY failure in a pack, not just the first', () => {
    // A validator that stopped at the first error would have someone fix one
    // rule, re-run, fix the next — and give up before the third.
    const { rules, errors } = validateRulePack([
      validRule,
      { ...validRule, id: 'slop.empty-catch' },
      { id: 'nope' },
    ]);
    expect(rules).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors.join(' ')).toMatch(/duplicate/);
  });
});

describe('the licence gate is deny-by-default', () => {
  it('allows the permissive set and ours', () => {
    for (const license of ALLOWED_LICENSES) expect(isAllowedLicense(license)).toBe(true);
  });

  it('REFUSES anything else, with the reason', () => {
    // Refused rather than queued for review: a rule that runs while someone
    // decides has already run.
    expect(() =>
      validateHealthRule(
        { ...validRule, provenance: { ...validRule.provenance, license: 'GPL-3.0' } },
        { enforceLicense: true },
      ),
    ).toThrow(/not on the import allowlist/);
    expect(isAllowedLicense('')).toBe(false);
  });
});

describe('the lifecycle', () => {
  it('never lets a proposal go straight to active', () => {
    // The gate needs evidence, and evidence needs the rule to have run.
    expect(canTransition('proposed', 'active')).toBe(false);
    expect(canTransition('proposed', 'candidate')).toBe(true);
    expect(canTransition('candidate', 'active')).toBe(true);
  });

  it('makes a revived rule earn shadow again', () => {
    expect(canTransition('deprecated', 'candidate')).toBe(true);
    expect(canTransition('deprecated', 'active')).toBe(false);
  });

  it('treats candidate as the shadow state', () => {
    expect(isShadow('candidate')).toBe(true);
    expect(isShadow('active')).toBe(false);
  });
});

describe('the promotion gate', () => {
  const ready = { findings: 25, daysActive: 40, fpRate: 0.1 };

  it('passes a rule with enough evidence and a low FP rate', () => {
    expect(promotionVerdict(ready)).toEqual({ eligible: true, reasons: [] });
  });

  it('lists EVERY unmet condition at once', () => {
    // An admin looking at a disabled button needs to know whether to wait a
    // week or fix the rule.
    const verdict = promotionVerdict({ findings: 3, daysActive: 2, fpRate: 0.9 });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toHaveLength(3);
  });

  it('refuses an UNTRIAGED rule, and says that is why', () => {
    // Not "the rate is bad" — nobody has looked, so the gate would be
    // measuring nothing at all.
    const verdict = promotionVerdict({ ...ready, fpRate: null });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons[0]).toMatch(/nothing has been triaged/);
  });

  it('uses the documented thresholds', () => {
    expect(PROMOTION_GATE).toEqual({ minFindings: 20, minDays: 30, maxFpRate: 0.2 });
  });

  it('is workspace-tunable', () => {
    expect(promotionVerdict({ findings: 5, daysActive: 5, fpRate: 0.1 }, {
      minFindings: 5,
      minDays: 5,
    }).eligible).toBe(true);
  });
});

describe('demotion and FP arithmetic', () => {
  it('flags a live rule past the trailing threshold', () => {
    expect(demotionFlag({ findings: 50, daysActive: 90, fpRate: 0.6 })).toBe(true);
    expect(demotionFlag({ findings: 50, daysActive: 90, fpRate: 0.4 })).toBe(false);
  });

  it('does NOT flag a rule nobody triaged', () => {
    // Auto-demoting on absence would punish a quiet week.
    expect(demotionFlag({ findings: 50, daysActive: 90, fpRate: null })).toBe(false);
  });

  it('is NULL over zero dispositions, never 0', () => {
    // A 0% FP rate across zero triaged findings reads as a flawless rule — and
    // that is exactly the rule nobody has checked.
    expect(fpRate({ dismissedFalsePositive: 0, triaged: 0 })).toBeNull();
    expect(fpRate({ dismissedFalsePositive: 1, triaged: 4 })).toBe(0.25);
  });
});

describe('shadow findings are real but weightless', () => {
  it('excludes experimental findings from anything that carries a number', () => {
    // One predicate, exported once, so scores, banners, plans and reports
    // cannot drift apart on what "shadow" means.
    expect(countsTowardsScores({ experimental: true })).toBe(false);
    expect(countsTowardsScores({ experimental: false })).toBe(true);
    // Absent flag = a finding from a live rule. Treating unknown as shadow
    // would silently drop every finding written before the column existed.
    expect(countsTowardsScores({})).toBe(true);
    expect(countsTowardsScores({ experimental: null })).toBe(true);
  });
});

describe('intake', () => {
  const dismissal = (ruleId: string | null, file: string) => ({
    ruleId,
    file,
    evidence: `${file}: something`,
  });

  it('clusters dismissals by rule and ignores the small ones', () => {
    // A cluster of one or two is a disagreement, not a pattern — drafting from
    // it would encode one reviewer's Tuesday into the product.
    const clusters = clusterDismissals([
      dismissal('bpm-ch-what-comment', 'a.ts'),
      dismissal('bpm-ch-what-comment', 'b.ts'),
      dismissal('bpm-ch-what-comment', 'c.ts'),
      dismissal('bpm-log-console-in-prod', 'd.ts'),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ sourceRuleId: 'bpm-ch-what-comment', size: 3 });
  });

  it('grounds the prompt in the examples and demands both fixtures', () => {
    const prompt = buildDraftPrompt({
      sourceRuleId: 'bpm-ch-what-comment',
      size: 4,
      samples: [{ file: 'a.ts', evidence: '// increment the counter' }],
    });
    expect(prompt).toContain('// increment the counter');
    expect(prompt).toContain('BOTH fixtures are required');
  });

  it('lands a draft as PROPOSED and never lets it name its own status', () => {
    // A draft that could name its status could propose itself active, and one
    // that could name its provenance could claim to be ours.
    const result = acceptDraft(
      { ...validRule, status: 'active', provenance: { source: 'trust me' } },
      new Date('2026-08-19T00:00:00Z'),
    );
    expect(result.ok).toBe(true);
    expect(result.rule?.status).toBe('proposed');
    expect(result.rule?.provenance.source).toBe('llm_draft');
  });

  it('DISCARDS a draft that fails validation rather than queuing it', () => {
    // A half-formed rule in the queue is one an admin eventually approves
    // without reading.
    const result = acceptDraft({ id: 'nope' }, new Date());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('rule');
  });
});
