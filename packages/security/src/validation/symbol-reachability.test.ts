import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGrypeMatches, type DependencyMatch } from '../scanners/dependency/matches.js';
import { dependencyFindings } from '../scanners/dependency/findings.js';
import { readRulepack, runSemgrepScan } from '../scanners/semgrep/scanner.js';
import {
  applicableEntries,
  callsFor,
  hasSymbolData,
  REACH_RULEPACK_DIR,
  REACH_RULEPACK_FILE,
  symbolReachability,
  type SymbolReachabilityResult,
} from './symbol-reachability.js';
import {
  reachRuleId,
  renderReachPack,
  ruleIndex,
  SYMBOL_CATALOGUE,
  symbolsFromOsv,
  symbolsOf,
} from './symbols.js';
import { validateVulnerabilities } from './validate.js';

// Symbol reachability for npm and PyPI (W18-46).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures/reachability');
const DEP_FIXTURES = path.resolve(HERE, '../../fixtures/dependency');
const PACK = path.join(REACH_RULEPACK_DIR, REACH_RULEPACK_FILE);
const packText = readFileSync(PACK, 'utf8');
const ids = [...packText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]!);

describe('the generated pack', () => {
  it('equals its rendering from the catalogue', () => {
    expect(packText).toBe(renderReachPack());
  });

  it('has one rule per catalogued symbol, each a provenance-stamped candidate', () => {
    const expected = [...ruleIndex().keys()].sort();
    expect([...ids].sort()).toEqual(expected);
    expect((packText.match(/provenance: written for RepoPulse/g) ?? []).length).toBe(ids.length);
    expect((packText.match(/lifecycle: candidate/g) ?? []).length).toBe(ids.length);
    for (const marker of ['semgrep.dev', 'r2c', 'javascript.lang.', 'python.lang.']) {
      expect(packText, marker).not.toContain(marker);
    }
  });

  it('is its own directory, so the SAST scan does not pick it up as findings', () => {
    expect(readRulepack(REACH_RULEPACK_DIR).files).toEqual([REACH_RULEPACK_FILE]);
    expect(REACH_RULEPACK_DIR).not.toContain(path.join('rulepacks', 'semgrep'));
  });
});

describe('the catalogue', () => {
  it('names real, distinct, well-formed symbols and ids', () => {
    for (const entry of SYMBOL_CATALOGUE) {
      expect(entry.advisories.length, entry.package).toBeGreaterThan(0);
      for (const advisory of entry.advisories) {
        expect(advisory.ids.length, entry.package).toBeGreaterThan(0);
        for (const id of advisory.ids) expect(id, id).toMatch(/^(CVE-\d{4}-\d{4,}|GHSA(-[2-9cfghjmpqrvwx]{4}){3})$/);
        for (const sym of advisory.symbols) expect(sym).toMatch(/^[A-Za-z_$][\w$]*$/);
      }
      expect(new Set(symbolsOf(entry)).size).toBe(symbolsOf(entry).length);
    }
    const keys = SYMBOL_CATALOGUE.map((e) => `${e.ecosystem}:${e.package.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reads symbols out of an OSV record that carries them, and says nothing otherwise', () => {
    const withSymbols = {
      id: 'GHSA-xxxx-xxxx-xxxx',
      aliases: ['CVE-2099-0001'],
      affected: [
        {
          package: { ecosystem: 'npm', name: 'left-pad' },
          ecosystem_specific: { imports: [{ path: 'left-pad', symbols: ['pad', 'padStart', 'not valid'] }] },
        },
      ],
    };
    expect(symbolsFromOsv(withSymbols)).toMatchObject({
      ecosystem: 'npm',
      package: 'left-pad',
      advisories: [{ ids: ['GHSA-xxxx-xxxx-xxxx', 'CVE-2099-0001'], symbols: ['pad', 'padStart'] }],
    });
    expect(symbolsFromOsv({ id: 'X', affected: [{ package: { ecosystem: 'npm', name: 'a' } }] })).toBeNull();
    expect(symbolsFromOsv(null)).toBeNull();
    expect(
      symbolsFromOsv({ id: 'G', affected: [{ package: { ecosystem: 'Go', name: 'a' }, ecosystem_specific: { imports: [{ symbols: ['F'] }] } }] }),
    ).toBeNull();
  });
});

const match = (over: Partial<DependencyMatch>): DependencyMatch => ({
  ...parseGrypeMatches(readFileSync(path.join(DEP_FIXTURES, 'jquery-grype.json'), 'utf8')).matches[0]!,
  ...over,
});
const lodashMatch = match({
  packageName: 'lodash',
  packageVersion: '4.17.15',
  packageType: 'npm',
  vulnerabilityId: 'GHSA-35jh-r3h4-6jhm',
  ids: ['GHSA-35JH-R3H4-6JHM', 'CVE-2021-23337'],
  cveId: 'CVE-2021-23337',
  purl: 'pkg:npm/lodash@4.17.15',
});

describe('joining calls to vulnerabilities', () => {
  const calls: SymbolReachabilityResult = {
    status: 'succeeded',
    toolVersion: '1.27.1',
    reason: null,
    packagesSearched: ['lodash'],
    calls: [
      { ruleId: 'bpm-reach-npm-lodash-template', package: 'lodash', symbol: 'template', file: 'src/a.js', line: 3 },
      { ruleId: 'bpm-reach-npm-lodash-merge', package: 'lodash', symbol: 'merge', file: 'src/b.js', line: 9 },
    ],
  };

  it('credits a call only to an advisory that names that function', () => {
    // CVE-2021-23337 names `template`, not `merge`.
    expect(callsFor(calls, lodashMatch, ['CVE-2021-23337'])).toEqual([
      { file: 'src/a.js', line: 3, symbol: 'lodash.template' },
    ]);
    // CVE-2018-16487 names merge, mergeWith, defaultsDeep — the `merge` call counts there.
    expect(callsFor(calls, lodashMatch, ['ghsa-4xc9-xhrj-v574'])).toEqual([
      { file: 'src/b.js', line: 9, symbol: 'lodash.merge' },
    ]);
    // An advisory the catalogue does not know gets nothing, whatever was called.
    expect(callsFor(calls, lodashMatch, ['CVE-2000-0001'])).toEqual([]);
  });

  it('never lends a package\'s call to another package', () => {
    expect(callsFor(calls, match({ packageName: 'underscore' }), ['CVE-2021-23358'])).toEqual([]);
    expect(callsFor(calls, match({ packageType: 'go-module' }), ['CVE-2021-23337'])).toEqual([]);
  });

  it('matches PyPI names the way PEP 503 does', () => {
    const py = match({ packageName: 'pyyaml', packageType: 'python' });
    expect(applicableEntries([py]).map((e) => e.package)).toEqual(['PyYAML']);
    expect(hasSymbolData(py, ['CVE-2017-18342'])).toBe(true);
    expect(hasSymbolData(py, ['CVE-2000-0001'])).toBe(false);
  });
});

describe('running the search', () => {
  const base = { targetDir: '/tmp/none', image: 'x', budget: { wallClockMs: 1000 } };
  const never = async () => {
    throw new Error('the engine must not start');
  };

  it('starts nothing when no vulnerable package has symbol data', async () => {
    const r = await symbolReachability({ ...base, matches: [match({ packageName: 'left-pad' })], run: never });
    expect(r).toMatchObject({ status: 'skipped', calls: [], packagesSearched: [] });
    expect(r.reason).toMatch(/no vulnerable package/);
  });

  it('reports a failed run with its reason, never as a clean search', async () => {
    const r = await symbolReachability({
      ...base,
      matches: [lodashMatch],
      run: async () => ({ status: 'timed_out', findings: [], toolErrors: [], durationMs: 1, error: 'wall clock', toolVersions: {} }),
    });
    expect(r).toMatchObject({ status: 'failed', reason: 'wall clock', packagesSearched: ['lodash'] });
  });

  it('keeps calls of the scanned packages only, once each, in a stable order', async () => {
    const f = (ruleId: string, file: string, line: number) =>
      ({ ruleId, file, lineStart: line, lineEnd: line, severity: 1, title: '', message: '', dimension: 'sast' }) as never;
    const r = await symbolReachability({
      ...base,
      matches: [lodashMatch],
      run: async () => ({
        status: 'succeeded',
        toolErrors: [],
        durationMs: 1,
        toolVersions: { opengrep: '1.27.1' },
        findings: [
          f('bpm-reach-npm-lodash-template', 'b.js', 2),
          f('bpm-reach-npm-lodash-template', 'a.js', 5),
          f('bpm-reach-npm-lodash-template', 'a.js', 5),
          f('bpm-reach-pypi-pyyaml-load', 'x.py', 1),
        ],
      }),
    });
    expect(r.status).toBe('succeeded');
    expect(r.toolVersion).toBe('1.27.1');
    expect(r.calls.map((c) => `${c.file}:${c.line}`)).toEqual(['a.js:5', 'b.js:2']);
  });
});

describe('the funnel verdict', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'w18-46-'));
  writeFileSync(path.join(empty, 'package.json'), '{"dependencies":{"lodash":"4.17.15"}}');
  const succeeded = (calls: SymbolReachabilityResult['calls']): SymbolReachabilityResult => ({
    status: 'succeeded',
    calls,
    toolVersion: null,
    reason: null,
    packagesSearched: ['lodash'],
  });
  const verdict = (symbols: SymbolReachabilityResult | null, m = lodashMatch) =>
    validateVulnerabilities({ matches: [m], snapshotDir: empty, symbolReachability: symbols }).vulnerabilities[0]!
      .reachability;

  it('upgrades to symbol_reachable on a call site, naming opengrep and the site', () => {
    const v = verdict(
      succeeded([{ ruleId: reachRuleId(SYMBOL_CATALOGUE[0]!, 'template'), package: 'lodash', symbol: 'template', file: 'src/a.js', line: 3 }]),
    );
    expect(v).toMatchObject({
      tier: 'symbol_reachable',
      provenBy: 'opengrep',
      unavailableReason: null,
      callSites: [{ file: 'src/a.js', line: 3, symbol: 'lodash.template' }],
    });
  });

  it('keeps the import tier and says what the empty search does not prove', () => {
    const v = verdict(succeeded([]));
    expect(v.tier).not.toBe('symbol_reachable');
    expect(v.tier).not.toBe('proven_unreachable');
    expect(v.unavailableReason).toMatch(/searched for as call sites and none was found.*not proof/);
  });

  it('says the search did not run when it did not', () => {
    const v = verdict({ status: 'failed', calls: [], toolVersion: null, reason: 'image missing', packagesSearched: ['lodash'] });
    expect(v.unavailableReason).toContain('did not run: image missing');
    expect(verdict(null).unavailableReason).toContain('did not run');
  });

  it('is silent about symbols it has no data for, and says so', () => {
    const v = verdict(succeeded([]), match({ packageName: 'left-pad', packageType: 'npm' }));
    expect(v.unavailableReason).toMatch(/no affected-symbol data.*stops at import/s);
  });

  it('writes a finding that says a call site is not exploitability', () => {
    const result = validateVulnerabilities({
      matches: [lodashMatch],
      snapshotDir: empty,
      symbolReachability: succeeded([
        { ruleId: 'bpm-reach-npm-lodash-template', package: 'lodash', symbol: 'template', file: 'src/a.js', line: 3 },
      ]),
    });
    const { findings } = dependencyFindings(result.vulnerabilities, { components: [] } as never);
    const text = JSON.stringify(findings[0]);
    expect(text).toContain('src/a.js:3');
    expect(text).toContain('not that untrusted data reaches it');
  });
});

// ---- The rules, on the fixtures ---------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** `ruleid:` announcements as `id:file:line`; the call is on the NEXT line. */
function announced(dir: string): string[] {
  const out: string[] = [];
  for (const file of walk(dir)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const m = /(?:\/\/|#)\s*ruleid:\s*(bpm-reach-\S+)/.exec(line);
        if (m) out.push(`${m[1]}:${path.relative(dir, file)}:${index + 2}`);
      });
  }
  return out.sort();
}

describe('the fixtures announce the rules', () => {
  it('trigger on every call form, name only real rules, and the clean tree announces nothing', () => {
    const triggering = announced(path.join(FIXTURES, 'triggering'));
    const named = new Set(triggering.map((a) => a.split(':')[0]));
    for (const rule of named) expect(ids, rule).toContain(rule);
    // One fixture per package the catalogue holds a rule for, at least.
    for (const entry of SYMBOL_CATALOGUE) {
      expect([...named].some((r) => r!.startsWith(`bpm-reach-${entry.ecosystem}-${entry.package.toLowerCase()}-`)), entry.package).toBe(true);
    }
    expect(announced(path.join(FIXTURES, 'clean'))).toEqual([]);
  });
});

const scanImage = (() => {
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { stdio: 'pipe' })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

// Through runSemgrepScan and the scan image, like every other pack's golden
// test; the ticket note records the same golden sets on a host semgrep 1.181.
(scanImage ? describe : describe.skip)('Symbol reachability golden sets (W18-46)', () => {
  const run = async (target: string) => {
    const result = await runSemgrepScan({
      targetDir: target,
      budget: { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 },
      rulepackDir: REACH_RULEPACK_DIR,
      rulepackFiles: (f) => f === REACH_RULEPACK_FILE,
      ...(scanImage ? { image: scanImage } : {}),
    });
    if (result.status !== 'succeeded') throw new Error(result.error ?? result.status);
    return result;
  };

  it('fires exactly where the triggering fixtures say', async () => {
    const dir = path.join(FIXTURES, 'triggering');
    const r = await run(dir);
    expect(r.toolErrors).toEqual([]);
    expect(r.findings.map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`).sort()).toEqual(announced(dir));
  }, 300_000);

  it('stays silent on the clean near-misses', async () => {
    const r = await run(path.join(FIXTURES, 'clean'));
    expect(r.toolErrors).toEqual([]);
    expect(r.findings).toEqual([]);
  }, 300_000);
});
