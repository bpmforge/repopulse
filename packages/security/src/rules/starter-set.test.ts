import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STARTER_SET_MANIFEST } from './starter-set.data.js';
import {
  STARTER_SET_BAR,
  STARTER_SET_EVIDENCE,
  deriveStarterSet,
  isStarterRule,
  meetsStarterBar,
  starterSetEntry,
  toolRowIsAdminChoice,
  type StarterSetReportInput,
} from './starter-set.js';

// The starter set must say exactly what the committed benchmark says (W21-04).
//
// A rule goes live on every new install because of an entry here, so an entry
// whose numbers no longer match docs/benchmarks/report.json, or no longer clear
// the bar, is a rule live on evidence that does not exist. After a new
// benchmark run: pnpm --filter @repopulse/security starter-set

const REPORT = new URL('../../../../docs/benchmarks/report.json', import.meta.url);
const report = JSON.parse(readFileSync(REPORT, 'utf8')) as StarterSetReportInput;

/** Recount one rule's evidence straight from the report's outcomes, independently of deriveStarterSet. */
function recount(ruleId: string, suite: string, trees?: readonly string[]) {
  let tp = 0;
  let fp = 0;
  for (const o of report.outcomes) {
    if (o.ruleId !== ruleId || o.suite !== suite) continue;
    if (trees && !trees.includes(o.tree ?? '')) continue;
    if (o.kind === 'tp') tp += 1;
    if (o.kind === 'fp') fp += 1;
  }
  return { tp, fp };
}

describe('starter-set manifest (W21-04)', () => {
  it('matches docs/benchmarks/report.json', () => {
    expect(STARTER_SET_MANIFEST).toEqual(deriveStarterSet(report));
  });

  it('is not empty, and every entry clears the bar on its own numbers', () => {
    expect(STARTER_SET_MANIFEST.rules.length).toBeGreaterThan(0);
    for (const entry of STARTER_SET_MANIFEST.rules) {
      expect(entry.tp, entry.ruleId).toBeGreaterThanOrEqual(STARTER_SET_BAR.minTruePositives);
      expect(entry.tp / (entry.tp + entry.fp), entry.ruleId).toBeGreaterThanOrEqual(
        STARTER_SET_BAR.minPrecision,
      );
      expect(entry.precision).toBe(Math.round((entry.tp / (entry.tp + entry.fp)) * 1000) / 1000);
    }
  });

  it("each entry's per-suite numbers are the report's outcomes, recounted", () => {
    for (const entry of STARTER_SET_MANIFEST.rules) {
      let tp = 0;
      let fp = 0;
      for (const s of entry.suites) {
        expect(recount(entry.ruleId, s.suite, s.trees), `${entry.ruleId} on ${s.suite}`).toEqual({
          tp: s.tp,
          fp: s.fp,
        });
        tp += s.tp;
        fp += s.fp;
      }
      expect({ tp, fp }).toEqual({ tp: entry.tp, fp: entry.fp });
    }
  });

  it('takes evidence only from independent suites, never our own corpora', () => {
    const allowed = new Set(STARTER_SET_EVIDENCE.map((e) => e.suite));
    for (const own of ['rule-fixtures', 'changes', 'sampleco'])
      expect(allowed.has(own)).toBe(false);
    for (const entry of STARTER_SET_MANIFEST.rules) {
      for (const s of entry.suites) expect(allowed.has(s.suite), s.suite).toBe(true);
    }
    // The adapter suite's triggering tree is fixtures we wrote; only real files count.
    expect(STARTER_SET_EVIDENCE.find((e) => e.suite === 'iac-adapters')?.trees).toEqual(['real']);
  });

  it('leaves out anti-slop, logging, performance and secrets rules (no independent sample)', () => {
    for (const entry of STARTER_SET_MANIFEST.rules) {
      expect(entry.ruleId).not.toMatch(/^slop\.|^bpm-(log|perf|ch)-/);
      expect(entry.dimension).not.toBe('secrets');
    }
  });

  it('lists rules with enough true positives but too many false positives, not as starters', () => {
    for (const entry of STARTER_SET_MANIFEST.belowBar) {
      expect(meetsStarterBar(entry)).toBe(false);
      expect(isStarterRule(entry.ruleId)).toBe(false);
    }
  });
});

describe('deriveStarterSet', () => {
  const base = { ticket: 'T', byRule: [{ rule: 'r', engine: 'yaml', dimension: 'sast' }] };
  const many = (n: number, o: { suite: string; tree?: string; ruleId: string; kind: string }) =>
    Array.from({ length: n }, () => o);

  it('needs five true positives on independent suites; fixtures and our own corpora do not count', () => {
    const m = deriveStarterSet({
      ...base,
      outcomes: [
        ...many(4, { suite: 'owasp-benchmark', ruleId: 'r', kind: 'tp' }),
        ...many(9, { suite: 'rule-fixtures', ruleId: 'r', kind: 'tp' }),
        ...many(9, { suite: 'changes', ruleId: 'r', kind: 'tp' }),
        ...many(9, { suite: 'iac-adapters', tree: 'triggering', ruleId: 'r', kind: 'tp' }),
      ],
    });
    expect(m.rules).toEqual([]);
    expect(m.belowBar).toEqual([]);
  });

  it('takes a rule at exactly 80% and leaves one just under it below the bar', () => {
    const m = deriveStarterSet({
      ...base,
      outcomes: [
        ...many(8, { suite: 'juliet-java', ruleId: 'r', kind: 'tp' }),
        ...many(2, { suite: 'owasp-benchmark', ruleId: 'r', kind: 'fp' }),
        ...many(7, { suite: 'juice-shop', ruleId: 's', kind: 'tp' }),
        ...many(2, { suite: 'juice-shop', ruleId: 's', kind: 'fp' }),
        ...many(5, { suite: 'iac-adapters', tree: 'real', ruleId: 't', kind: 'tp' }),
      ],
    });
    expect(m.rules.map((r) => [r.ruleId, r.precision])).toEqual([
      ['r', 0.8],
      ['t', 1],
    ]);
    expect(m.rules[0]!.suites).toEqual([
      { suite: 'juliet-java', tp: 8, fp: 0 },
      { suite: 'owasp-benchmark', tp: 0, fp: 2 },
    ]);
    expect(m.rules[1]!.suites).toEqual([{ suite: 'iac-adapters', trees: ['real'], tp: 5, fp: 0 }]);
    expect(m.belowBar.map((r) => [r.ruleId, r.precision])).toEqual([['s', 0.778]]);
  });
});

describe('who decides for an adapter tool', () => {
  it('a seeded tool row is the default made visible; a status or a name on it is a decision', () => {
    expect(toolRowIsAdminChoice({ status: 'candidate', updatedBy: null })).toBe(false);
    expect(toolRowIsAdminChoice({ status: 'candidate', updatedBy: 7 })).toBe(true);
    expect(toolRowIsAdminChoice({ status: 'active', updatedBy: null })).toBe(true);
    expect(toolRowIsAdminChoice({ status: 'deprecated', updatedBy: 7 })).toBe(true);
  });

  it('looks entries up by rule id', () => {
    const first = STARTER_SET_MANIFEST.rules[0]!;
    expect(starterSetEntry(first.ruleId)).toEqual(first);
    expect(starterSetEntry('no-such-rule')).toBeUndefined();
  });
});
