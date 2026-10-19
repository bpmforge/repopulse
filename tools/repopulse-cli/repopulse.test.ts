import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXIT,
  evaluate,
  main,
  parseArgs,
  sarifLevel,
  toMarkdown,
  toSarif,
  UsageError,
} from './repopulse.mjs';

// The CI side of W18-18. Everything a customer's pipeline relies on is pure
// here — argument parsing, the verdict, SARIF and markdown — so it is tested
// without a server; `main` is driven against a fake fetch for the wiring.

type Finding = Parameters<typeof toMarkdown>[0]['items'][number];
type Config = Extract<ReturnType<typeof parseArgs>, { kind: 'check' }>['config'];

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 1,
    rule_id: 'bpm-sql-injection',
    scanner_key: 'semgrep',
    dimension: 'security',
    severity: 4,
    severity_label: 'high',
    confidence: 4,
    title: 'SQL built from request input',
    file: 'src/db.ts',
    line_start: 12,
    line_end: 14,
    evidence: 'src/db.ts:12 — query(`select * from t where id = ${req.id}`)',
    suggested_fix: 'Use a parameterised query.',
    experimental: false,
    status: 'open',
    introduced_by_pr: true,
    seen_at_head: true,
    ...over,
  };
}

function result(items: Finding[], over: { scanned?: boolean; head?: string } = {}) {
  const head = over.head ?? 'abc1234def';
  return {
    pull: { number: 7, title: 'Add thing', state: 'open', head_sha: head, base_ref: 'main' },
    head: {
      sha: head,
      scanned: over.scanned ?? true,
      scanners: [{ scanner_key: 'semgrep', scanned_at: '2026-10-15T00:00:00.000Z' }],
    },
    items,
  };
}

const ENV = { REPOPULSE_TOKEN: 'rpci_test' };
const BASE = ['check', '--server', 'https://rp.example', '--repo', '3', '--pr', '7'];

function config(extra: string[] = []): Config {
  const parsed = parseArgs([...BASE, ...extra], ENV);
  if (parsed.kind !== 'check') throw new Error('expected check');
  return parsed.config;
}

describe('parseArgs', () => {
  it('parses the documented invocation with defaults', () => {
    expect(config()).toEqual({
      server: 'https://rp.example',
      token: 'rpci_test',
      repo: 3,
      pr: 7,
      failOn: 'high',
      maxNew: null,
      includeExperimental: false,
      sha: null,
      waitSeconds: 0,
      allowUnscanned: false,
      sarif: null,
      markdown: null,
      json: null,
    });
  });

  it('accepts --opt=value, flags, and REPOPULSE_SERVER', () => {
    const parsed = parseArgs(
      [
        'check',
        '--repo=3',
        '--pr',
        '7',
        '--fail-on=critical',
        '--max-new',
        '0',
        '--include-experimental',
      ],
      { ...ENV, REPOPULSE_SERVER: 'http://rp.local:3000/' },
    );
    expect(parsed).toMatchObject({
      kind: 'check',
      config: {
        server: 'http://rp.local:3000',
        failOn: 'critical',
        maxNew: 0,
        includeExperimental: true,
      },
    });
  });

  it('refuses to run without a token, and never takes one from argv', () => {
    expect(() => parseArgs(BASE, {})).toThrow(/REPOPULSE_TOKEN/);
    expect(() => parseArgs([...BASE, '--token', 'x'], ENV)).toThrow(/unknown option --token/);
  });

  it.each([
    [['--fail-on', 'severe'], /--fail-on/],
    [['--max-new', '-1'], /--max-new/],
    [['--wait', 'soon'], /--wait/],
    [['--include-experimental=yes'], /takes no value/],
    [['stray'], /unexpected argument/],
  ])('rejects %j', (extra, message) => {
    expect(() => parseArgs([...BASE, ...extra], ENV)).toThrow(message);
  });

  it('requires repo and pr', () => {
    expect(() => parseArgs(['check', '--server', 'https://x'], ENV)).toThrow(UsageError);
  });

  it('answers help and version', () => {
    expect(parseArgs([], ENV)).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'], ENV)).toEqual({ kind: 'version' });
  });
});

describe('evaluate — the thresholds', () => {
  it('passes when nothing reaches the severity threshold', () => {
    const v = evaluate(result([finding({ severity: 3, severity_label: 'medium' })]), config());
    expect(v.exitCode).toBe(EXIT.PASS);
  });

  it('fails at or above --fail-on (default high)', () => {
    const v = evaluate(
      result([finding({ severity: 4 }), finding({ id: 2, severity: 2 })]),
      config(),
    );
    expect(v.exitCode).toBe(EXIT.THRESHOLD);
    expect(v.atOrAbove.map((f) => f.id)).toEqual([1]);
    expect(v.reasons[0]).toMatch(/1 new finding at or above high/);
  });

  it('--fail-on none disables the severity gate; --max-new still applies', () => {
    const items = [finding({ severity: 5 }), finding({ id: 2 }), finding({ id: 3 })];
    expect(evaluate(result(items), config(['--fail-on', 'none'])).exitCode).toBe(EXIT.PASS);
    const v = evaluate(result(items), config(['--fail-on', 'none', '--max-new', '2']));
    expect(v.exitCode).toBe(EXIT.THRESHOLD);
    expect(v.reasons).toEqual(['3 new findings (limit 2)']);
    expect(evaluate(result(items), config(['--fail-on', 'none', '--max-new', '3'])).exitCode).toBe(
      EXIT.PASS,
    );
  });

  it('--fail-on info fails on any finding at all', () => {
    const v = evaluate(result([finding({ severity: 1 })]), config(['--fail-on', 'info']));
    expect(v.exitCode).toBe(EXIT.THRESHOLD);
  });

  it('is NOT READY when the head has not been scanned, unless --allow-unscanned', () => {
    const items = [finding({ severity: 5 })];
    expect(evaluate(result(items, { scanned: false }), config()).exitCode).toBe(EXIT.NOT_READY);
    expect(
      evaluate(result(items, { scanned: false }), config(['--allow-unscanned'])).exitCode,
    ).toBe(EXIT.THRESHOLD);
  });

  it('is NOT READY when RepoPulse holds a different head than --sha', () => {
    const v = evaluate(result([], { head: 'old0000' }), config(['--sha', 'new1111']));
    expect(v.exitCode).toBe(EXIT.NOT_READY);
    expect(v.reasons[0]).toMatch(/has head old0000, not new1111/);
  });
});

/**
 * The SARIF 2.1.0 constraints a consumer actually enforces (GitHub code
 * scanning rejects uploads that break these). Checked structurally: the
 * official schema is a network fetch, and a test must not depend on one.
 */
function assertSarif21(doc: unknown): void {
  const d = doc as Record<string, unknown>;
  expect(d['version']).toBe('2.1.0');
  expect(d['$schema']).toMatch(/sarif-2\.1\.0/);
  const runs = d['runs'] as Record<string, unknown>[];
  expect(Array.isArray(runs) && runs.length).toBe(1);
  for (const run of runs) {
    const driver = (run['tool'] as { driver: Record<string, unknown> }).driver;
    expect(typeof driver['name']).toBe('string');
    const rules = driver['rules'] as { id: string; shortDescription: { text: string } }[];
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    for (const r of rules) expect(typeof r.shortDescription.text).toBe('string');
    for (const res of run['results'] as Record<string, unknown>[]) {
      expect(['none', 'note', 'warning', 'error']).toContain(res['level']);
      expect(typeof (res['message'] as { text: string }).text).toBe('string');
      // ruleIndex must point at the rule with the same id.
      expect(rules[res['ruleIndex'] as number]?.id).toBe(res['ruleId']);
      for (const loc of (res['locations'] as Record<string, unknown>[] | undefined) ?? []) {
        const phys = loc['physicalLocation'] as {
          artifactLocation: { uri: string };
          region?: { startLine: number; endLine?: number };
        };
        expect(typeof phys.artifactLocation.uri).toBe('string');
        if (phys.region) {
          expect(Number.isInteger(phys.region.startLine)).toBe(true);
          expect(phys.region.startLine).toBeGreaterThanOrEqual(1);
          if (phys.region.endLine !== undefined) {
            expect(phys.region.endLine).toBeGreaterThanOrEqual(phys.region.startLine);
          }
        }
      }
    }
  }
}

describe('toSarif', () => {
  const items = [
    finding(),
    finding({ id: 2, line_start: 40, line_end: 40 }), // same rule, second result
    finding({
      id: 3,
      rule_id: null,
      scanner_key: 'dependency',
      file: null,
      line_start: null,
      line_end: null,
      severity: 3,
      severity_label: 'medium',
    }),
    finding({ id: 4, rule_id: 'bpm-log-console', line_start: null, line_end: null, severity: 1 }),
  ];
  const sarif = toSarif(result(items), config());

  it('is valid SARIF 2.1.0 in shape', () => {
    assertSarif21(sarif);
    // And it survives a JSON round trip, which is how it reaches the uploader.
    assertSarif21(JSON.parse(JSON.stringify(sarif)));
  });

  it('dedupes rules and maps severity to SARIF levels', () => {
    const run = sarif.runs[0]!;
    expect(run.tool.driver.rules.map((r) => r['id'])).toEqual([
      'bpm-sql-injection',
      'repopulse.dependency',
      'bpm-log-console',
    ]);
    expect(run.results.map((r) => r['level'])).toEqual(['error', 'error', 'warning', 'note']);
    expect([5, 4, 3, 2, 1].map(sarifLevel)).toEqual(['error', 'error', 'warning', 'note', 'note']);
  });

  it('never invents a location: a repository-level finding has none, a lineless one has no region', () => {
    const [, , repoLevel, lineless] = sarif.runs[0]!.results;
    expect(repoLevel!['locations']).toBeUndefined();
    expect(lineless!['locations']).toEqual([
      { physicalLocation: { artifactLocation: { uri: 'src/db.ts' } } },
    ]);
  });

  it('carries the head commit and a stable fingerprint per finding', () => {
    const run = sarif.runs[0]!;
    expect(run.properties).toEqual({ headSha: 'abc1234def', pullRequest: 7 });
    expect(run.results[1]!['partialFingerprints']).toEqual({ repopulseFindingId: '2' });
  });
});

describe('toMarkdown', () => {
  it('summarises the verdict and every finding, without letting evidence break out', () => {
    const items = [finding({ title: 'a | b', evidence: 'x ``` y' })];
    const r = result(items);
    const md = toMarkdown(r, evaluate(r, config()), config());
    expect(md).toContain('### RepoPulse: 1 new finding on #7 — failed');
    expect(md).toContain('Head `abc1234` scanned by: semgrep.');
    expect(md).toContain('1 new finding at or above high');
    expect(md).toContain('a \\| b');
    expect(md).toContain('````\nx ``` y\n````');
    expect(md).toContain('**Suggested fix:** Use a parameterised query.');
    // N-9: no grades, no scores.
    expect(md).not.toMatch(/grade|score/i);
  });

  // W20-08 (UX_TODO FND-50): every row links back to its finding, and the
  // comment says how a wrong finding stops failing the build.
  it('links each finding to RepoPulse and says how to clear a false positive', () => {
    const r = result([finding({ id: 42 })]);
    const md = toMarkdown(r, evaluate(r, config()), config());
    expect(md).toContain(`[View in RepoPulse](${config().server}/findings?finding=42)`);
    expect(md).toMatch(/dismiss it with a reason.*next run of this check clears it/);
  });

  it('says plainly when there is nothing new', () => {
    const r = result([]);
    expect(toMarkdown(r, evaluate(r, config()), config())).toContain('No new findings.');
  });
});

describe('main', () => {
  function harness(pages: unknown[], status = 200) {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const files = new Map<string, string>();
    let out = '';
    let err = '';
    let page = 0;
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const body = pages[Math.min(page++, pages.length - 1)];
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    let clock = 0;
    const io = {
      out: (t: string) => void (out += t),
      err: (t: string) => void (err += t),
      fetch: fetchImpl,
      writeFile: async (p: string, d: string) => void files.set(p, d),
      sleep: async (ms: number) => void (clock += ms),
      now: () => clock,
    };
    return { io, requests, files, out: () => out, err: () => err };
  }

  it('follows next_cursor, sends the token as a bearer, and writes every report', async () => {
    const h = harness([
      { ...result([finding()]), next_cursor: 'c2' },
      { ...result([finding({ id: 2, severity: 2 })]), next_cursor: null },
    ]);
    const code = await main(
      [...BASE, '--sarif', 'out.sarif', '--markdown', 'out.md', '--json', 'out.json'],
      ENV,
      h.io,
    );
    expect(code).toBe(EXIT.THRESHOLD);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]!.url).toBe(
      'https://rp.example/api/v1/repos/3/pulls/7/findings?new=true&include_experimental=false&limit=100',
    );
    expect(h.requests[1]!.url).toContain('cursor=c2');
    // Read-only: every request is a GET with the token in the header.
    for (const r of h.requests) {
      expect(r.init?.method).toBe('GET');
      expect((r.init?.headers as Record<string, string>)['authorization']).toBe('Bearer rpci_test');
    }
    expect(JSON.parse(h.files.get('out.sarif')!).runs[0].results).toHaveLength(2);
    expect(h.files.get('out.md')).toContain('2 new findings');
    expect(JSON.parse(h.files.get('out.json')!).items).toHaveLength(2);
  });

  it('polls until the head is scanned when --wait allows', async () => {
    const h = harness([
      { ...result([], { scanned: false }), next_cursor: null },
      { ...result([], { scanned: true }), next_cursor: null },
    ]);
    expect(await main([...BASE, '--wait', '60'], ENV, h.io)).toBe(EXIT.PASS);
    expect(h.requests).toHaveLength(2);
  });

  it('gives up as NOT READY when the wait runs out', async () => {
    const h = harness([{ ...result([], { scanned: false }), next_cursor: null }]);
    expect(await main([...BASE, '--wait', '30'], ENV, h.io)).toBe(EXIT.NOT_READY);
  });

  it('reports a refused token as a server error with a hint, not as a pass', async () => {
    const h = harness([{ title: 'Invalid, expired or revoked token', status: 401 }], 401);
    expect(await main(BASE, ENV, h.io)).toBe(EXIT.SERVER);
    expect(h.err()).toMatch(/HTTP 401: Invalid, expired or revoked token.*REPOPULSE_TOKEN/);
  });

  it('exits 2 with usage on bad arguments', async () => {
    const h = harness([]);
    expect(await main(['check'], ENV, h.io)).toBe(EXIT.USAGE);
    expect(h.err()).toMatch(/--server/);
  });
});

describe('the shipped file', () => {
  const source = readFileSync(new URL('./repopulse.mjs', import.meta.url), 'utf8');

  it('has no imports beyond node: builtins (zero runtime dependencies)', () => {
    const specifiers = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toMatch(/^node:/);
  });

  it('makes only GET requests (D9a: nothing in the CI pull model writes)', () => {
    const methods = [...source.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
    expect(methods).toEqual(['GET']);
  });
});
