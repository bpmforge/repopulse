import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isThirdPartyRule,
  readThirdPartyPack,
  THIRD_PARTY_RULEPACK_DIR,
} from '../../rules/third-party.js';
import { scanPatch } from './detect.js';
import {
  compileGitleaks,
  GITLEAKS_TOML,
  goRegExp,
  loadGitleaks,
  parseGitleaksToml,
  translateGoRegex,
} from './gitleaks.js';
import { loadRulepack, type Rulepack } from './rulepack.js';
import { withThirdParty } from './rulepack.js';

// W22-07: gitleaks' secrets rules, imported verbatim through the ledger and
// run as shadow candidates. Tokens below are assembled at runtime so that no
// whole credential-shaped string is committed.

const TOML = GITLEAKS_TOML(THIRD_PARTY_RULEPACK_DIR);
const ours = loadRulepack();
const ourIds = new Set(ours.rules.map((r) => r.id));

function patch(...lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

function packOf(toml: string): Rulepack {
  const { rules } = compileGitleaks(parseGitleaksToml(toml), { ours: new Set() });
  return { version: 1, versionTag: 't', rules };
}

describe('Go RE2 -> JavaScript', () => {
  it.each([
    ['p8e-(?i)[a-z0-9]{2}', 'p8e-[A-Za-z0-9]{2}'],
    ['(?i)ab(?-i:C)d', '[aA][bB](?:C)[dD]'],
    ['(?i:x)y', '(?:[xX])y'],
    ['[^]]+]', '[^\\]]+]'],
    ['[[:alnum:]]', '[a-zA-Z0-9]'],
    ['(?s:.)', '(?:[\\s\\S])'],
    ['(?P<alg>x)\\z', '(?<alg>x)$'],
    // The other case goes first, or `_-` would become a range.
    ['(?i)[a-z0-9_-]', '[A-Za-z0-9_-]'],
  ])('%s -> %s', (go, js) => {
    expect(translateGoRegex(go)).toBe(js);
    expect(() => new RegExp(js)).not.toThrow();
  });

  it('case-insensitivity lasts to the end of the group it was turned on in', () => {
    const re = goRegExp('(a(?i)b)c');
    expect(re.test('aBc')).toBe(true);
    expect(re.test('aBC')).toBe(false);
    expect(re.test('ABc')).toBe(false);
  });

  it('refuses what it cannot translate exactly', () => {
    expect(() => translateGoRegex('(?U)a+')).toThrow(/flag/);
    expect(() => translateGoRegex('[[:nope:]]')).toThrow(/POSIX/);
    expect(() => translateGoRegex('(a')).toThrow(/unbalanced/);
  });
});

describe('the TOML subset fails closed', () => {
  it('reads a rule, its allowlists and the global allowlist', () => {
    const cfg = parseGitleaksToml(
      [
        'title = "t"',
        '[allowlist]',
        "paths = [\n    '''vendor/''',\n]",
        '[[rules]]',
        'id = "x"',
        'description = "X"',
        "regex = '''x([0-9]+)'''",
        'entropy = 2.5',
        'keywords = ["x"]',
        '[[rules.allowlists]]',
        'regexTarget = "line"',
        "regexes = ['''ok''']",
      ].join('\n'),
    );
    expect(cfg.global.paths).toEqual(['vendor/']);
    expect(cfg.rules[0]).toMatchObject({ id: 'x', entropy: 2.5, keywords: ['x'] });
    expect(cfg.rules[0]!.allowlists[0]).toMatchObject({ regexTarget: 'line', regexes: ['ok'] });
  });

  it('throws on a field, section or value it does not know', () => {
    expect(() => parseGitleaksToml('[[rules]]\nid = "x"\nentropu = 1')).toThrow(
      /unknown rule field/,
    );
    expect(() => parseGitleaksToml('[extend]\n')).toThrow(/cannot read/);
    expect(() => parseGitleaksToml('[[rules]]\nid = "x"\nkeywords = [\n"a",\n')).toThrow(
      /unterminated/,
    );
    expect(() => parseGitleaksToml('[[rules]]\ndescription = "no id"')).toThrow(/no id/);
  });
});

describe('the shipped gitleaks rules', () => {
  it('parses all 222 rules at the pinned commit', () => {
    const { rules } = loadGitleaks(TOML, new Set());
    // 221 run; pkcs12-file matches a file name, which this scanner never reads.
    expect(rules).toHaveLength(221);
  });

  it('loads every rule we do not already ship, and says why each other one is skipped', () => {
    const { rules, skipped } = loadGitleaks(TOML, ourIds);
    expect(skipped.filter((s) => !/our rule of the same id/.test(s.reason))).toEqual([
      { id: 'pkcs12-file', reason: 'matches a file name only; this scanner reads content' },
    ]);
    expect(rules.length).toBeGreaterThan(150);
    for (const r of rules) {
      expect(ourIds.has(r.id), r.id).toBe(false);
      expect(r.candidate, r.id).toBe(true);
    }
  });

  it('the ledger lists their ids as third-party (shadow), never one of ours', () => {
    const pack = readThirdPartyPack()!;
    expect(pack.secretsFiles).toEqual(['gitleaks/config/gitleaks.toml']);
    expect(pack.files.some((f) => f.endsWith('.toml'))).toBe(false); // never handed to Opengrep
    expect(isThirdPartyRule('stripe-access-token')).toBe(true);
    for (const id of ourIds) expect(isThirdPartyRule(id), id).toBe(false);
  });

  it('joins our pack only through withThirdParty, with the commit in the version tag', () => {
    expect(ours.versionTag).toBe('secrets.v1'); // SCAN_THIRD_PARTY_RULES is off in tests
    const both = withThirdParty(ours);
    expect(both.versionTag).toBe('secrets.v1+gitleaks.5f6ec56');
    expect(both.rules.slice(0, ours.rules.length)).toEqual(ours.rules);
    expect(withThirdParty(ours, path.join(THIRD_PARTY_RULEPACK_DIR, 'nowhere'))).toBe(ours);
  });
});

describe("gitleaks' match semantics", () => {
  const rule = (extra: string) =>
    `[[rules]]\nid = "demo-key"\ndescription = "Demo"\nregex = '''(demo_)?key_([a-z0-9]{12})'''\nkeywords = ["key_"]\n${extra}`;

  it('the secret is the first non-empty capture group', () => {
    const [m] = scanPatch('a.ts', patch('x = key_abc123def456'), { rulepack: packOf(rule('')) });
    expect(m?.secret).toBe('abc123def456');
  });

  it('an entropy floor drops a match at or below it, and a generic rule needs a digit', () => {
    const floor = packOf(rule('entropy = 3.5'));
    expect(scanPatch('a.ts', patch('key_aaaaaaaaaaaa'), { rulepack: floor })).toEqual([]);
    const generic = packOf(
      `[[rules]]\nid = "generic-x"\ndescription = "G"\nregex = '''tok=([a-z]{10})'''\nentropy = 1\nkeywords = ["tok"]`,
    );
    expect(scanPatch('a.ts', patch('tok=abcdefghij'), { rulepack: generic })).toEqual([]);
  });

  it('honours gitleaks:allow, path allowlists and line-targeted allowlists', () => {
    const p = packOf(
      `[allowlist]\npaths = ['''(?:^|/)vendor/''']\n${rule("[[rules.allowlists]]\nregexTarget = \"line\"\nregexes = ['''EXAMPLE''']")}`,
    );
    const hit = 'key_abc123def456';
    expect(scanPatch('a.ts', patch(hit), { rulepack: p })).toHaveLength(1);
    expect(scanPatch('a.ts', patch(`${hit} // gitleaks:allow`), { rulepack: p })).toEqual([]);
    expect(scanPatch('vendor/a.ts', patch(hit), { rulepack: p })).toEqual([]);
    expect(scanPatch('a.ts', patch(`${hit} # EXAMPLE`), { rulepack: p })).toEqual([]);
  });

  it('an AND allowlist needs every criterion', () => {
    const p = packOf(
      rule(
        `[[rules.allowlists]]\ncondition = "AND"\npaths = ['''docs/''']\nregexTarget = "line"\nregexes = ['''sample''']`,
      ),
    );
    const hit = 'key_abc123def456 sample';
    expect(scanPatch('src/a.ts', patch(hit), { rulepack: p })).toHaveLength(1);
    expect(scanPatch('docs/a.md', patch('key_abc123def456'), { rulepack: p })).toHaveLength(1);
    expect(scanPatch('docs/a.md', patch(hit), { rulepack: p })).toEqual([]);
  });
});

describe('beside our pack', () => {
  const both = withThirdParty(ours);

  it('a gitleaks hit on a secret our own rule already found is not a second finding', () => {
    const token = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ'].join('');
    const hits = scanPatch('a.ts', patch(`const t = "${token}"`), { rulepack: both });
    expect(hits.map((h) => h.ruleId)).toEqual(['github-pat']);
  });

  it('a gitleaks rule finds what ours do not, as a shadow candidate after our hits', () => {
    // Stripe's live-key shape with a prefix our pack has no rule for (sk_prod_).
    const stripe = ['sk', '_prod_', 'a1B2c3D4e5F6g7H8i9J0'].join('');
    const hits = scanPatch('a.ts', patch(`stripe = "${stripe}"`), { rulepack: both });
    expect(hits.map((h) => h.ruleId)).toEqual(['stripe-access-token']);
    const rule = both.rules.find((r) => r.id === 'stripe-access-token')!;
    expect(rule.candidate).toBe(true);
    expect(rule.severity).toBe(3);
  });

  it('a generic hit yields to a specific one on the same secret', () => {
    const stripe = ['sk', '_prod_', 'a1B2c3D4e5F6g7H8i9J0'].join('');
    const hits = scanPatch('a.ts', patch(`api_key = "${stripe}"`), { rulepack: both });
    expect(hits.map((h) => h.ruleId)).not.toContain('generic-api-key');
  });
});
