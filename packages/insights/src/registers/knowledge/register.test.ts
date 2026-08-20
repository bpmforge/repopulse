import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_IDENTITY_KEYS,
  KNOWLEDGE_DEFAULTS,
  knowledgeFindings,
  moduleOf,
  type ModuleConcentration,
} from './register.js';
import { CATALOG_V1, CATALOG_VERSION } from '../../plans/catalog.v1.js';

// Knowledge-concentration register (W10-01, FR-REG-1, N-9).

const module = (over: Partial<ModuleConcentration> = {}): ModuleConcentration => ({
  module: 'src/billing',
  maintainers: 1,
  topShare: 0.95,
  totalLines: 800,
  ...over,
});

describe('N-9: counts and shares, never people', () => {
  it('names NO ONE in any string a finding carries', () => {
    // The constraint that shapes this whole register. A bus-factor finding
    // that names the person is a leaderboard with a safety-flavoured excuse,
    // and NON_GOALS N-9 rejects it at review.
    const [finding] = knowledgeFindings([module()]);
    const payload = JSON.stringify(finding).toLowerCase();
    for (const key of FORBIDDEN_IDENTITY_KEYS) {
      expect(payload, key).not.toContain(`"${key.toLowerCase()}"`);
    }
    // And no @ anywhere — an email or a handle would both carry one.
    expect(payload).not.toContain('@');
  });

  it('keeps identity out of the TYPES that leave this module', () => {
    // The boundary is the return type, not a count of mentions. The query
    // MUST read authorIdentityId — you cannot count distinct authors without
    // it — so an occurrence count would either be meaningless or break on a
    // legitimate refactor. What matters is that neither exported shape can
    // carry a person out.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, 'register.ts'), 'utf8');

    const interfaces = [...source.matchAll(/export interface (\w+) \{([^}]*)\}/g)];
    expect(interfaces.length).toBeGreaterThanOrEqual(2);
    for (const [, name, body] of interfaces) {
      for (const key of FORBIDDEN_IDENTITY_KEYS) {
        expect(body?.toLowerCase(), `${name}.${key}`).not.toContain(key.toLowerCase());
      }
    }

    // And no identity COLUMN is selected: forge_login and display_name have
    // no reason to be read here at all. (Checked on the select/join lines
    // rather than the whole file, because the N-9 comment and the denylist
    // constant both legitimately spell these words out.)
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    expect(codeLines.join('\n')).not.toMatch(/forgeLogin|displayName|identities\./);
  });

  it('states the counts it used, so the threshold is what gets argued with', () => {
    const [finding] = knowledgeFindings([module({ maintainers: 1, topShare: 0.9 })]);
    expect(finding?.evidence).toMatch(/1 active contributor/);
    expect(finding?.evidence).toMatch(/90% of 800 changed lines/);
  });

  it('recommends pairing, not reassignment', () => {
    // The finding is about a team's resilience. A recommendation that reads as
    // "move this person" would be the product making a staffing decision.
    const [finding] = knowledgeFindings([module()]);
    expect(finding?.recommendation).toMatch(/Pair or rotate/);
    expect(finding?.recommendation).toMatch(/not a reassignment/);
  });
});

describe('both conditions must hold', () => {
  it('fires on few maintainers AND a high top share', () => {
    expect(knowledgeFindings([module({ maintainers: 1, topShare: 0.95 })])).toHaveLength(1);
  });

  it('stays silent when there are enough maintainers', () => {
    // A high top share with five contributors is a maintainer, not a bus
    // factor.
    expect(knowledgeFindings([module({ maintainers: 5, topShare: 0.95 })])).toEqual([]);
  });

  it('stays silent when the work is spread, even in a small team', () => {
    expect(knowledgeFindings([module({ maintainers: 2, topShare: 0.5 })])).toEqual([]);
  });

  it('ignores a module too quiet to judge', () => {
    // A module touched twice in six months has a bus factor of one the way an
    // empty room has a fire risk of zero.
    expect(knowledgeFindings([module({ totalLines: 10 })])).toEqual([]);
  });

  it('is workspace-tunable', () => {
    expect(
      knowledgeFindings([module({ maintainers: 3, topShare: 0.7 })], {
        ...KNOWLEDGE_DEFAULTS,
        maxMaintainers: 3,
        minTopShare: 0.7,
      }),
    ).toHaveLength(1);
  });

  it('never claims a security severity', () => {
    // A staffing risk outranking a live vulnerability is a mis-sorted list.
    for (const m of [module({ maintainers: 1 }), module({ maintainers: 2 })]) {
      expect(knowledgeFindings([m])[0]?.severity).toBeLessThanOrEqual(3);
    }
  });
});

describe('module grouping', () => {
  it('groups by directory, not by file', () => {
    expect(moduleOf('src/billing/invoice.ts')).toBe('src/billing');
    expect(moduleOf('src/billing/deep/nested/file.ts')).toBe('src/billing');
    expect(moduleOf('README.md')).toBe('(root)');
  });
});

describe('the plan entry', () => {
  it('verifies over NINETY days, not thirty', () => {
    // A second maintainer who reviewed one PR in a quiet week has not learned
    // a module.
    const entry = CATALOG_V1.find((e) => e.id === 'knowledge-cluster');
    expect(entry?.verifyCriterion.windowDays).toBe(90);
    expect(entry?.verifyCriterion.target).toBe(0);
    // v5 since W10-02 added its dependency-currency entry; this assertion is
    // about the knowledge entry's window, and the version moves with the
    // catalog rather than with this test's subject.
    expect(CATALOG_VERSION).toBe('v5');
  });

  it('proposes nothing when the register has not run', () => {
    const entry = CATALOG_V1.find((e) => e.id === 'knowledge-cluster');
    expect(entry?.condition({})).toBe(false);
  });
});
