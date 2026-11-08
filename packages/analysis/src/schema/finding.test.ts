import { describe, expect, it } from 'vitest';
import {
  FindingParseError,
  clampProse,
  dedupKeyInput,
  findingSchema,
  retryPromptFor,
  validateFindings,
} from './finding.js';

// Finding schema + evidence validation (W6-02, ANALYSIS_TIERS.md §4,
// FR-ANALYSIS-5/6).

const CHUNK = `--- src/auth.ts
@@ -10,4 +10,6 @@
+  const token = req.query.token;
+  if (!token) return next();
+  db.query('select * from users where id = ' + userId);`;

const finding = (over: Record<string, unknown> = {}) => ({
  dimension: 'security',
  severity: 5,
  confidence: 4,
  file: 'src/auth.ts',
  line_range: [12, 12],
  title: 'SQL built by concatenation',
  evidence_quote: "db.query('select * from users where id = ' + userId);",
  rationale: 'User-controlled id is concatenated into SQL.',
  suggested_fix: 'Use a parameterised query.',
  ...over,
});

describe('finding schema', () => {
  it('accepts a well-formed finding whose quote is in the diff', () => {
    const { findings, rejected } = validateFindings({ findings: [finding()] }, CHUNK);
    expect(findings).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it('REJECTS a finding whose quote is not in the diff', () => {
    // The load-bearing check. A model asked for a verbatim quote will sometimes
    // produce a plausible paraphrase, and a finding whose evidence is not in
    // the diff is a finding about code that does not exist.
    const { findings, rejected } = validateFindings(
      { findings: [finding({ evidence_quote: 'db.execute(dangerousThing())' })] },
      CHUNK,
    );
    expect(findings).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/verbatim substring/);
  });

  it('tolerates whitespace reflow, which models do constantly', () => {
    // Rejecting a correct finding over a line wrap would teach everyone to
    // switch the validator off — which costs far more than it saves.
    const reflowed = "db.query('select * from users where id = '   +   userId);";
    const { findings } = validateFindings(
      { findings: [finding({ evidence_quote: reflowed })] },
      CHUNK,
    );
    expect(findings).toHaveLength(1);
  });

  it('rejects an empty quote rather than matching everything', () => {
    // '' is a substring of every string: without this, a model that omitted
    // its evidence would have every finding accepted.
    const { findings, rejected } = validateFindings(
      { findings: [finding({ evidence_quote: '  ' })] },
      CHUNK,
    );
    expect(findings).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/empty/);
  });

  it('throws on structurally invalid output, naming the field', () => {
    expect(() => validateFindings({ findings: [finding({ severity: 9 })] }, CHUNK)).toThrow(
      FindingParseError,
    );
    expect(() => validateFindings({ nope: true }, CHUNK)).toThrow(FindingParseError);
  });

  it('requires suggested_fix to be present, even when null', () => {
    // Nullable, not optional: "no fix suggested" is an answer; a missing key is
    // a model that stopped early.
    expect(findingSchema.safeParse({ ...finding(), suggested_fix: null }).success).toBe(true);
    const withoutFix: Record<string, unknown> = { ...finding() };
    delete withoutFix.suggested_fix;
    expect(findingSchema.safeParse(withoutFix).success).toBe(false);
  });
});

describe('over-long prose (W27-11)', () => {
  it('cuts title, rationale and fix to their limits instead of failing the answer', () => {
    const quote = 'const x = 1;';
    const raw = {
      findings: [
        {
          dimension: 'performance',
          severity: 2,
          confidence: 3,
          file: 'a.ts',
          line_range: [1, 1],
          title: 't'.repeat(200),
          evidence_quote: quote,
          rationale: 'r'.repeat(1_500),
          suggested_fix: 'f'.repeat(900),
        },
      ],
    };
    const { findings } = validateFindings(raw, `+${quote}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toHaveLength(120);
    expect(findings[0]!.rationale).toHaveLength(800);
    expect(findings[0]!.rationale.endsWith('\u2026')).toBe(true);
    expect(findings[0]!.suggested_fix).toHaveLength(800);
  });

  it('never shortens the evidence quote', () => {
    const raw = { findings: [{ evidence_quote: 'q'.repeat(700), rationale: 'ok' }] };
    expect(clampProse(raw)).toEqual(raw);
  });
});

describe('retry prompt', () => {
  it('appends the error to the ORIGINAL prompt', () => {
    const retry = retryPromptFor('review this diff', 'severity: expected <= 5');
    // A model told only "that was invalid" has lost the diff it was reviewing
    // and will produce well-formed output about nothing.
    expect(retry).toContain('review this diff');
    expect(retry).toContain('severity: expected <= 5');
  });
});

describe('dedup key', () => {
  it('is stable across line drift within a bucket', () => {
    // A finding that shifts a few lines after an unrelated edit above it is the
    // SAME finding; keying on the exact line would resurrect it as new.
    const a = dedupKeyInput({
      dimension: 'security',
      file: 'a.ts',
      evidence_quote: 'x = 1',
      line_range: [12, 12],
    });
    const b = dedupKeyInput({
      dimension: 'security',
      file: 'a.ts',
      evidence_quote: 'x = 9',
      line_range: [15, 15],
    });
    expect(a).toBe(b);
  });

  it('separates different files and dimensions', () => {
    const base = { evidence_quote: 'x', line_range: [1, 1] as [number, number] };
    expect(dedupKeyInput({ ...base, dimension: 'security', file: 'a.ts' })).not.toBe(
      dedupKeyInput({ ...base, dimension: 'security', file: 'b.ts' }),
    );
    expect(dedupKeyInput({ ...base, dimension: 'security', file: 'a.ts' })).not.toBe(
      dedupKeyInput({ ...base, dimension: 'performance', file: 'a.ts' }),
    );
  });
});
