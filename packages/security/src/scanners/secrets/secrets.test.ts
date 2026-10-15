import { describe, expect, it } from 'vitest';
import { addedLines, scanPatch, shannonEntropy } from './detect.js';
import { compileRulepack, loadRulepack, parseRulepackYaml, RulepackError } from './rulepack.js';
import { buildSecretFindings } from './scanner.js';
import { escalate, LiveVerificationUnavailableError, verifyMatch } from './verify.js';

// Secrets scanner (W8-04, SECURITY_SUITE.md 3.1, FR-SEC-3 / SC-29).

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GH_TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ'.slice(0, 36)}`;

function patch(...lines: string[]): string {
  return ['@@ -1,3 +1,6 @@', ...lines].join('\n');
}

describe('the rulepack loader fails closed', () => {
  it('loads the shipped pack and stamps its version', () => {
    const pack = loadRulepack();
    expect(pack.version).toBe(1);
    expect(pack.versionTag).toBe('secrets.v1');
    expect(pack.rules.length).toBeGreaterThan(10);
    expect(pack.rules.map((r) => r.id)).toContain('aws-access-key-id');
  });

  it('THROWS on an unknown rule field rather than ignoring it', () => {
    // `entropu: 4.2` would otherwise mean "no entropy floor at all", and
    // nobody would notice until the alert volume changed.
    expect(() =>
      compileRulepack({
        version: 1,
        rules: [{ id: 'x', description: 'd', kind: 'k', severity: 3, regex: 'a', entropu: 4.2 }],
      }),
    ).toThrow(RulepackError);
  });

  it('THROWS on a missing field, a duplicate id and a bad regex', () => {
    const base = { id: 'x', description: 'd', kind: 'k', severity: 3, regex: 'a' };
    expect(() =>
      compileRulepack({ version: 1, rules: [{ ...base, id: undefined } as never] }),
    ).toThrow(/missing "id"/);
    expect(() => compileRulepack({ version: 1, rules: [base, { ...base }] })).toThrow(/duplicate/);
    expect(() => compileRulepack({ version: 1, rules: [{ ...base, regex: '([' }] })).toThrow(
      /invalid regex/,
    );
    expect(() => compileRulepack({ version: 1, rules: [{ ...base, severity: 9 }] })).toThrow(
      /expected 1-5/,
    );
  });

  it('THROWS on YAML it does not understand, rather than dropping the rule', () => {
    // A detector that silently vanishes from the pack produces exactly the same
    // output as a clean repository.
    expect(() =>
      compileRulepack(parseRulepackYaml('version: 1\nrules:\n  - id: x\n    weird: 1\n')),
    ).toThrow(/unknown rule field/);
    expect(() => parseRulepackYaml('version: 1\nrules:\n  not a key value line\n')).toThrow();
    expect(() => parseRulepackYaml('rules:\n  - id: x\n')).toThrow(/no version/);
  });

  it("translates Go's inline (?i) into the JavaScript flag", () => {
    // Gitleaks rules are written for Go's regexp, which takes (?i) inline.
    // Dropping it silently would quietly narrow every assignment rule to
    // lower-case only — a rule that still fires, just less often.
    const pack = compileRulepack({
      version: 1,
      rules: [{ id: 'x', description: 'd', kind: 'k', severity: 3, regex: '(?i)SeCrEt' }],
    });
    expect(pack.rules[0]?.regex.flags).toContain('i');
    expect(pack.rules[0]?.regex.test('secret')).toBe(true);
  });

  it('does not swallow the rule that FOLLOWS a list', () => {
    // A real bug this caught: keying "new rule vs list item" on whether a list
    // was open put every rule after a keywords block into the previous rule's
    // keywords, and the pack lost half its detectors while still loading
    // cleanly. Indentation decides now, and the shipped pack is the proof.
    const parsed = parseRulepackYaml(
      [
        'version: 1',
        'rules:',
        '  - id: first',
        '    keywords:',
        '      - abc',
        '  - id: second',
        '    description: d',
      ].join('\n'),
    );
    expect(parsed.rules.map((r) => r['id'])).toEqual(['first', 'second']);
    expect(parsed.rules[0]?.['keywords']).toEqual(['abc']);
    // And the shipped pack really carries every rule the file declares.
    const declared = loadRulepack().rules.length;
    expect(declared).toBe(15);
  });

  it('keeps a regex verbatim through quoting', () => {
    const parsed = parseRulepackYaml(
      ['version: 1', 'rules:', '  - id: x', "    regex: '(?i)a[\"\\s:=]{1,10}(b)'"].join('\n'),
    );
    expect(parsed.rules[0]?.['regex']).toBe('(?i)a["\\s:=]{1,10}(b)');
  });
});

describe('diff reading — added lines only', () => {
  it('numbers added lines from the hunk header', () => {
    // The location is ALL that gets stored for a secret, so an off-by-a-hunk
    // line number sends someone to the wrong place.
    const lines = addedLines(
      ['@@ -10,2 +20,3 @@', ' context', '+added one', '-removed', '+added two'].join('\n'),
    );
    expect(lines).toEqual([
      { line: 21, text: 'added one' },
      { line: 22, text: 'added two' },
    ]);
  });

  it('IGNORES removed lines', () => {
    // A key on a removed line was already committed - that is history mode.
    // Reporting it here would fire on every PR that deletes an old config and
    // present a cleanup as a new leak.
    const matches = scanPatch('config.ts', patch(`-const key = '${AWS_KEY}';`));
    expect(matches).toEqual([]);
  });

  it('finds a secret on an added line', () => {
    const matches = scanPatch('config.ts', patch(`+const key = '${AWS_KEY}';`));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ ruleId: 'aws-access-key-id', kind: 'aws', line: 1 });
  });
});

describe('the rulepack in anger', () => {
  it('catches the credential families the pack claims to catch', () => {
    const cases: [string, string][] = [
      ['aws-access-key-id', `+const k = '${AWS_KEY}';`],
      ['github-pat', `+const t = '${GH_TOKEN}';`],
      ['stripe-secret-key', `+sk = 'sk_live_${'a1B2c3D4e5F6g7H8i9J0kLmN'}';`],
      ['slack-token', `+const s = 'xoxb-123456789012-abcdefghijkl';`],
      ['private-key-block', '+-----BEGIN RSA PRIVATE KEY-----'],
      ['google-api-key', `+key: 'AIza${'aB3dEfGhIjKlMnOpQrStUvWxYz012345678'.slice(0, 35)}'`],
    ];
    for (const [ruleId, line] of cases) {
      const matches = scanPatch('f.ts', patch(line));
      expect(
        matches.map((m) => m.ruleId),
        ruleId,
      ).toContain(ruleId);
    }
  });

  it('does NOT fire on a placeholder', () => {
    // The generic rule is the one most likely to be wrong, and a false positive
    // is a person interrupted. Placeholders are what template files are full of.
    for (const line of [
      `+api_key = "your-api-key-here"`,
      `+password = "changeme"`,
      `+token: \${GITHUB_TOKEN}`,
      `+secret = "<your-secret>"`,
    ]) {
      expect(scanPatch('.env.example', patch(line)), line).toEqual([]);
    }
  });

  it('catches a Stripe-prefixed key whose body contains underscores', () => {
    // The W18-17 benchmark miss, SampleCo's fake key verbatim. The generic
    // rule allowlists it for "sample", so only this rule can catch it. Not an
    // issued Stripe format, so it stays "unverified", but a live-prefixed
    // credential in a config file is the finding whatever its exact shape.
    // Built at runtime so this file is not itself a push-protection hit.
    const key = ['sk', 'live', '51H8xQ2eZvKf9sampleco_DO_NOT_USE_9f3a'].join('_');
    const matches = scanPatch('config.js', patch(`+  apiKey: "${key}",`));
    expect(matches.map((m) => [m.ruleId, m.secret])).toEqual([['stripe-secret-key', key]]);
    expect(verifyMatch(matches[0]!).outcome).toBe('unverified');
    // An issued-format key is still reported whole, and still format-checks.
    const issued = ['sk', 'test', 'a1B2c3D4e5F6g7H8i9J0kLmN'].join('_');
    const plain = scanPatch('a.ts', patch(`+k = '${issued}'`));
    expect(plain.map((m) => m.secret)).toEqual([issued]);
    expect(verifyMatch(plain[0]!).outcome).toBe('format_ok');
  });

  it('does NOT read an identifier that starts with the Stripe prefix as a key', () => {
    // Allowing `_` in the body lets names through the regex; the allowlist has
    // to turn every ordinary naming style away, or the fix above is a new
    // stream of severity-5 false positives.
    for (const name of [
      'sk_live_webhook_endpoint_secret_v2',
      'sk_test_environment_configuration_value',
      'sk_live_MAX_RETRY_COUNT_FOR_REQUESTS',
      'sk_test_webhookSecretRotation_enabledForTenant',
    ]) {
      expect(scanPatch('a.ts', patch(`+const ${name} = loadFromVault();`)), name).toEqual([]);
    }
  });

  it('does NOT fire on low-entropy values under an entropy floor', () => {
    expect(scanPatch('a.ts', patch('+password = "aaaaaaaaaaaaaaaaaaaaaaaa"'))).toEqual([]);
  });

  it('reports an anthropic key once, not twice under the openai rule', () => {
    // sk-ant- matches both prefixes; the openai rule allowlists it, because two
    // findings for one credential means two triage decisions for one problem.
    const matches = scanPatch('a.ts', patch(`+const k = 'sk-ant-api03-${'x'.repeat(40)}';`));
    expect(matches.map((m) => m.ruleId)).toEqual(['anthropic-api-key']);
  });

  it('measures entropy the standard way', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBe(1);
    expect(shannonEntropy(AWS_KEY)).toBeGreaterThan(3);
  });
});

describe('verification and escalation (SECURITY_SUITE 3.1)', () => {
  const match = {
    ruleId: 'github-pat',
    kind: 'github',
    severity: 5,
    file: 'a.ts',
    line: 1,
    secret: GH_TOKEN,
    entropy: 4.5,
  };

  it('a FORMAT match raises confidence but never claims verified', () => {
    // Shape is not liveness: a revoked token and a live one are the same string.
    const result = verifyMatch(match);
    expect(result.outcome).toBe('format_ok');
    expect(escalate(match, result)).toEqual({
      severity: 5,
      confidence: 4,
      surfaceImmediately: false,
    });
  });

  it('only a VERIFIED credential escalates to 5/5 and surfaces immediately', () => {
    expect(escalate(match, { outcome: 'verified', reason: 'issuer confirmed' })).toEqual({
      severity: 5,
      confidence: 5,
      surfaceImmediately: true,
    });
  });

  it('a format check never raises SEVERITY', () => {
    // If a shape check could set severity 5, every AKIA... in a test fixture
    // would page someone.
    const low = { ...match, ruleId: 'jwt', severity: 3, secret: 'eyJhbGci.eyJzdWIi.sig' };
    expect(escalate(low, verifyMatch(low)).severity).toBe(3);
  });

  it('live verification THROWS when enabled, rather than quietly doing nothing', () => {
    // A switch that reads as on and does nothing is worse than no switch.
    expect(() => verifyMatch(match, { liveVerification: true })).toThrow(
      LiveVerificationUnavailableError,
    );
  });
});

describe('findings never carry the secret (SC-29)', () => {
  it('stores a fingerprint, a location and the rulepack version — never the value', () => {
    const findings = buildSecretFindings({
      files: [{ path: 'src/config.ts', patch: patch(`+const key = '${AWS_KEY}';`) }],
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    const serialized = JSON.stringify(finding);
    expect(serialized).not.toContain(AWS_KEY);
    // Not even the prefix: "AKIA..." plus a repository name is often enough.
    expect(serialized).not.toContain(AWS_KEY.slice(0, 8));
    expect(finding.evidenceQuote).toContain('secrets.v1');
    expect(finding.file).toBe('src/config.ts');
    expect(finding.lineStart).toBe(1);
    expect(finding.scannerKey).toBe('secrets');
    expect(finding.ruleId).toBe('aws-access-key-id');
    // Chaining input: the attack chainer matches this against another
    // finding's preconditions.
    expect(finding.yields).toEqual({ 'credential:aws': true });
    expect(finding.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('gives the same credential the same fingerprint in two files', () => {
    const [a] = buildSecretFindings({
      files: [{ path: 'a.ts', patch: patch(`+k = '${AWS_KEY}'`) }],
    });
    const [b] = buildSecretFindings({
      files: [{ path: 'b.ts', patch: patch(`+k = '${AWS_KEY}'`) }],
    });
    expect(a!.fingerprint).toBe(b!.fingerprint);
  });

  it('skips binary and patchless files instead of guessing', () => {
    expect(buildSecretFindings({ files: [{ path: 'logo.png', patch: null }] })).toEqual([]);
  });
});
