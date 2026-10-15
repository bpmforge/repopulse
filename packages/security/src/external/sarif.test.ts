import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FINDING_DIMENSIONS } from '@repopulse/shared/dimensions';
import { dedupKey } from '@repopulse/insights';
import { extractSarifResults, parseSarif, repoRelativePath, MAX_RESULTS } from './sarif.js';
import {
  confidenceFor,
  dimensionFor,
  severityFor,
  toIncomingFinding,
  type ExternalResult,
} from './map.js';
import { externalScannerKey, parseExternalScannerKey, toolSlug } from './keys.js';
import { alertToResult } from './code-scanning.js';
import { dedupeExternalAgainstPack } from './ingest.js';
import { packRuleSupersedingExternal } from '../scanners/code-health/adapters/registry.js';

// SARIF → findings mapping (W18-24), over small fixtures written in the shape
// semgrep, CodeQL and the ESLint SARIF formatter actually emit (OASIS SARIF
// 2.1.0 and each tool's published output). No database here: the mapping is a
// pure function, and the integration suite covers storage.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures/external/sarif');
const load = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown;

function extract(name: string) {
  const parsed = parseSarif(load(name));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return extractSarifResults(parsed.log);
}

const base: ExternalResult = {
  tool: 'SomeTool',
  toolVersion: null,
  ruleId: 'r1',
  ruleTitle: null,
  level: null,
  securitySeverity: null,
  precision: null,
  tags: [],
  file: 'a.js',
  lineStart: 1,
  lineEnd: 1,
  message: 'm',
  fingerprint: null,
};

describe('SARIF validation (W18-24)', () => {
  it('accepts the three tool fixtures', () => {
    for (const f of ['semgrep.sarif.json', 'codeql.sarif.json', 'eslint.sarif.json']) {
      expect(parseSarif(load(f)).ok, f).toBe(true);
    }
  });

  it('refuses anything that is not SARIF 2.1.0, saying where', () => {
    const wrongVersion = parseSarif({ version: '2.0.0', runs: [] });
    expect(wrongVersion.ok).toBe(false);
    const noDriver = parseSarif({ version: '2.1.0', runs: [{ tool: {} }] });
    expect(noDriver.ok).toBe(false);
    if (!noDriver.ok) expect(noDriver.errors[0]!.path).toBe('runs.0.tool.driver');
    expect(parseSarif('not json at all').ok).toBe(false);
    expect(parseSarif(null).ok).toBe(false);
    expect(parseSarif({ version: '2.1.0', runs: [] }).ok).toBe(false);
  });

  it('caps the result count across runs', () => {
    const results = Array.from({ length: MAX_RESULTS / 2 + 1 }, () => ({
      ruleId: 'x',
      message: { text: 'm' },
    }));
    const run = { tool: { driver: { name: 't' } }, results };
    const parsed = parseSarif({ version: '2.1.0', runs: [run, run] });
    expect(parsed.ok).toBe(false);
  });

  it('never keeps what it does not map — snippets, code flows, command lines', () => {
    const parsed = parseSarif(load('semgrep.sarif.json'));
    expect(parsed.ok).toBe(true);
    const kept = JSON.stringify(parsed.ok ? parsed.log : null);
    expect(kept).not.toContain('snippet');
    expect(kept).not.toContain('commandLine');
    expect(kept).not.toContain('return eval(req.query.expr)');
    const codeql = JSON.stringify((parseSarif(load('codeql.sarif.json')) as { log: unknown }).log);
    expect(codeql).not.toContain('codeFlows');
  });
});

describe('semgrep SARIF', () => {
  const { results, skipped } = extract('semgrep.sarif.json');

  it('maps both results with tool provenance and fingerprints', () => {
    expect(skipped).toEqual({});
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      tool: 'Semgrep OSS',
      toolVersion: '1.85.0',
      ruleId: 'rulepacks.semgrep.bpm-js-eval-dynamic',
      file: 'src/server.js',
      lineStart: 12,
      lineEnd: 12,
      level: 'error',
      precision: 'very-high',
    });
    expect(results[0]!.fingerprint).toMatch(/^matchBasedId\/v1=/);
  });

  it('security-tagged rules are sast; an untagged team rule is code_health', () => {
    expect(dimensionFor(results[0]!)).toBe('sast');
    expect(dimensionFor(results[1]!)).toBe('code_health');
    expect(severityFor(results[0]!)).toBe(4);
    expect(severityFor(results[1]!)).toBe(3);
  });

  it('our own bpm-* rule under semgrep’s config-path prefix yields to our pack by identity', () => {
    expect(packRuleSupersedingExternal('semgrep-oss', results[0]!.ruleId)).toBe(
      'bpm-js-eval-dynamic',
    );
    expect(packRuleSupersedingExternal('semgrep-oss', results[1]!.ruleId)).toBeNull();
  });
});

describe('CodeQL SARIF', () => {
  const { results, skipped, revisionId } = extract('codeql.sarif.json');

  it('finds rule metadata in tool.extensions, not just the driver', () => {
    const sqli = results.find((r) => r.ruleId === 'js/sql-injection')!;
    expect(sqli).toMatchObject({
      tool: 'CodeQL',
      toolVersion: '2.19.0',
      ruleTitle: 'Database query built from user-controlled sources',
      securitySeverity: 8.8,
      precision: 'high',
      file: 'src/db.js',
      lineStart: 17,
      // No endLine in the region: a single-line result, not an open range.
      lineEnd: 17,
      level: 'error',
    });
    expect(sqli.fingerprint).toBe(
      'primaryLocationLineHash=c6a3b9e2f1d40a77:1|primaryLocationStartColumnFingerprint=17',
    );
    expect(dimensionFor(sqli)).toBe('sast');
    // 8.8 is GitHub's "high" band.
    expect(severityFor(sqli)).toBe(4);
    expect(confidenceFor(sqli)).toBe(4);
  });

  it('a maintainability query is code_health at note level', () => {
    const unused = results.find((r) => r.ruleId === 'js/unused-local-variable')!;
    expect(dimensionFor(unused)).toBe('code_health');
    expect(severityFor(unused)).toBe(2);
  });

  it('skips the in-source suppressed result and reads the analysed commit', () => {
    expect(results).toHaveLength(3);
    expect(skipped).toEqual({ suppressed: 1 });
    expect(revisionId).toBe('3f786850e387550fdab836ed7e6dc881de23001b');
  });

  it('weak crypto yields to our pack rule; taint-tracked SQLi does not', () => {
    expect(packRuleSupersedingExternal('codeql', 'js/weak-cryptographic-algorithm')).toBe(
      'bpm-js-weak-hash',
    );
    // keep: 'tool' — both stay.
    expect(packRuleSupersedingExternal('codeql', 'js/sql-injection')).toBeNull();
  });
});

describe('ESLint SARIF', () => {
  const { results, skipped } = extract('eslint.sarif.json');

  it('strips the GitHub Actions checkout root from absolute file URIs', () => {
    expect(skipped).toEqual({});
    expect(results.map((r) => r.file)).toEqual(['src/util.js', 'src/cart.js', 'src/cart.js']);
  });

  it('resolves a location given only by artifact index', () => {
    expect(results[1]).toMatchObject({ ruleId: 'eqeqeq', file: 'src/cart.js', lineStart: 4 });
  });

  it('reads the tool version and maps to code_health', () => {
    expect(results[0]).toMatchObject({ tool: 'ESLint', toolVersion: '9.10.0' });
    expect(results.every((r) => dimensionFor(r) === 'code_health')).toBe(true);
    expect(results[0]!.fingerprint).toBeNull();
  });

  it('no-empty is mapped onto our empty-catch rule, scoped to eslint', () => {
    expect(packRuleSupersedingExternal('eslint', 'no-empty')).toBe('bpm-ch-empty-catch');
    // A different tool's rule of the same name is not assumed to mean the same.
    expect(packRuleSupersedingExternal('otherlint', 'no-empty')).toBeNull();
  });
});

describe('paths are strings, never followed', () => {
  it('refuses traversal and unknown absolute roots', () => {
    expect(repoRelativePath('../../etc/passwd', undefined, undefined)).toBeNull();
    expect(repoRelativePath('src/../../x.js', undefined, undefined)).toBeNull();
    expect(repoRelativePath('file:///opt/build/app/src/a.js', undefined, undefined)).toBeNull();
    expect(repoRelativePath('%2e%2e/secret', undefined, undefined)).toBeNull();
  });

  it('uses a supplied source root or originalUriBaseIds', () => {
    expect(
      repoRelativePath('file:///opt/build/app/src/a.js', undefined, undefined, ['/opt/build/app']),
    ).toBe('src/a.js');
    expect(
      repoRelativePath('file:///opt/build/app/src/a.js', undefined, {
        SRCROOT: { uri: 'file:///opt/build/app/' },
      }),
    ).toBe('src/a.js');
    expect(repoRelativePath('a.js', 'PKG', { PKG: { uri: 'packages/web/' } })).toBe(
      'packages/web/a.js',
    );
  });

  it('a non-file URI is a repository-level result, not a path', () => {
    expect(repoRelativePath('https://example.com/x.js', undefined, undefined)).toBeUndefined();
    expect(repoRelativePath(undefined, undefined, undefined)).toBeUndefined();
  });

  it('drops a traversal result and counts it', () => {
    const parsed = parseSarif({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 't' } },
          results: [
            {
              ruleId: 'r',
              message: { text: 'm' },
              locations: [{ physicalLocation: { artifactLocation: { uri: '../x' } } }],
            },
            { ruleId: 'r', kind: 'pass', message: { text: 'ok' } },
            { ruleId: 'r', baselineState: 'absent', message: { text: 'gone' } },
          ],
        },
      ],
    });
    if (!parsed.ok) throw new Error('fixture invalid');
    const out = extractSarifResults(parsed.log);
    expect(out.results).toEqual([]);
    expect(out.skipped).toEqual({ unusable_path: 1, not_a_failure: 1, absent_from_baseline: 1 });
  });
});

describe('severity, dimension, finding', () => {
  it('security-severity bands win over level', () => {
    expect(severityFor({ securitySeverity: 9.8, level: 'note' })).toBe(5);
    expect(severityFor({ securitySeverity: 5, level: 'error' })).toBe(3);
    expect(severityFor({ securitySeverity: 0.5, level: null })).toBe(2);
    // SARIF's default level is warning, not "unknown".
    expect(severityFor({ securitySeverity: null, level: null })).toBe(3);
    expect(severityFor({ securitySeverity: null, level: 'none' })).toBe(1);
  });

  it('only ever emits an existing dimension', () => {
    const cases: Partial<ExternalResult>[] = [
      { tool: 'gitleaks' },
      { tool: 'checkov' },
      { tool: 'Trivy', ruleId: 'CVE-2024-12345' },
      { tool: 'grype', ruleId: 'GHSA-abcd-1234-wxyz' },
      { tool: 'bandit' },
      { tags: ['external/cwe/cwe-079'] },
      { tags: ['performance'] },
      {},
    ];
    const dims = cases.map((c) => dimensionFor({ ...base, ...c }));
    expect(dims).toEqual([
      'secrets',
      'iac',
      'dependency',
      'dependency',
      'sast',
      'sast',
      'performance',
      'code_health',
    ]);
    for (const d of dims) expect(FINDING_DIMENSIONS).toContain(d);
  });

  it('stores under the tool’s external key with a namespaced rule id', () => {
    const f = toIncomingFinding({ ...base, tool: 'Semgrep OSS', ruleId: 'team.x' }, 'sarif');
    expect(f.scannerKey).toBe('external:semgrep-oss');
    expect(f.ruleId).toBe('external.semgrep-oss.team.x');
    expect(f.title).toBe('team.x (Semgrep OSS)');
    expect(f.evidenceQuote).toBe('a.js:1 — semgrep-oss/team.x');
  });

  it('never stores a secrets tool’s message', () => {
    const f = toIncomingFinding(
      { ...base, tool: 'gitleaks', ruleId: 'aws-key', message: 'found AKIAABCDEFGHIJKLMNOP' },
      'sarif',
    );
    expect(f.dimension).toBe('secrets');
    expect(JSON.stringify(f)).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('a CVE result carries its cve id', () => {
    expect(toIncomingFinding({ ...base, ruleId: 'cve-2024-1' }, 'sarif').cveId).toBe('CVE-2024-1');
  });
});

describe('scanner keys', () => {
  it('upload and pull are different keys for the same tool', () => {
    expect(externalScannerKey('CodeQL', 'sarif')).toBe('external:codeql');
    expect(externalScannerKey('CodeQL', 'code_scanning')).toBe('external:codeql:code-scanning');
    expect(parseExternalScannerKey('external:codeql:code-scanning')).toEqual({
      tool: 'codeql',
      source: 'code_scanning',
    });
    expect(parseExternalScannerKey('semgrep')).toBeNull();
    expect(toolSlug('  Snyk Code ')).toBe('snyk-code');
    expect(toolSlug('???')).toBe('unknown-tool');
  });
});

describe('fingerprint dedup', () => {
  it('a fingerprinted finding keeps its key when its line moves', () => {
    const at = (line: number) =>
      dedupKey({
        dimension: 'sast',
        file: 'src/db.js',
        evidenceQuote: `src/db.js:${line} — codeql/js/sql-injection`,
        lineStart: line,
        scannerKey: 'external:codeql',
        ruleId: 'external.codeql.js/sql-injection',
        fingerprint: 'primaryLocationLineHash=abc:1',
      });
    expect(at(17)).toBe(at(95));
  });

  it('the same fingerprint in two files is two findings', () => {
    const inFile = (file: string) =>
      dedupKey({
        dimension: 'sast',
        file,
        evidenceQuote: 'x',
        lineStart: 1,
        scannerKey: 'external:codeql',
        ruleId: 'r',
        fingerprint: 'h:1',
      });
    expect(inFile('a.js')).not.toBe(inFile('b.js'));
  });

  it('without a scanner key the fingerprint is ignored, so analysis keys never move', () => {
    const input = { dimension: 'security', file: 'a.js', evidenceQuote: 'q', lineStart: 3 };
    expect(dedupKey({ ...input, fingerprint: 'h' })).toBe(dedupKey(input));
  });
});

describe('dedup against our pack (pure half)', () => {
  const eslintEmpty: ExternalResult = {
    ...base,
    tool: 'ESLint',
    ruleId: 'no-empty',
    file: 'src/util.js',
    lineStart: 21,
  };

  it('drops only where our rule fired at the same place', () => {
    const near = dedupeExternalAgainstPack(
      [eslintEmpty, { ...eslintEmpty, file: 'src/cart.js', lineStart: 50 }],
      [{ ruleId: 'bpm-ch-empty-catch', file: 'src/util.js', lineStart: 20 }],
    );
    expect(near.kept.map((r) => r.file)).toEqual(['src/cart.js']);
    expect(near.superseded).toEqual([
      { ruleId: 'no-empty', packRule: 'bpm-ch-empty-catch', file: 'src/util.js', line: 21 },
    ]);
  });

  it('a pack hit far away in the same file does not swallow it', () => {
    const far = dedupeExternalAgainstPack(
      [eslintEmpty],
      [{ ruleId: 'bpm-ch-empty-catch', file: 'src/util.js', lineStart: 90 }],
    );
    expect(far.kept).toHaveLength(1);
  });
});

describe('code-scanning alerts use the same mapper', () => {
  it('maps band, tool and alert number', () => {
    const r = alertToResult({
      number: 42,
      state: 'open',
      ruleId: 'js/sql-injection',
      ruleName: 'js/sql-injection',
      ruleDescription: 'Database query built from user-controlled sources',
      ruleSeverity: 'error',
      securitySeverityLevel: 'high',
      ruleTags: ['security', 'external/cwe/cwe-089'],
      toolName: 'CodeQL',
      toolVersion: '2.19.0',
      path: 'src/db.js',
      startLine: 17,
      endLine: 17,
      message: 'This query depends on a user-provided value.',
      commitSha: null,
      htmlUrl: null,
    });
    expect(severityFor(r)).toBe(4);
    expect(dimensionFor(r)).toBe('sast');
    const f = toIncomingFinding(r, 'code_scanning');
    expect(f).toMatchObject({
      scannerKey: 'external:codeql:code-scanning',
      fingerprint: 'alert:42',
      file: 'src/db.js',
    });
  });

  it('every GitHub band maps to the severity the same SARIF score would', () => {
    const bands = { critical: 5, high: 4, medium: 3, low: 2 } as const;
    for (const [band, sev] of Object.entries(bands)) {
      const r = alertToResult({
        number: 1,
        state: 'open',
        ruleId: 'r',
        ruleName: null,
        ruleDescription: null,
        ruleSeverity: null,
        securitySeverityLevel: band,
        ruleTags: [],
        toolName: 't',
        toolVersion: null,
        path: null,
        startLine: null,
        endLine: null,
        message: null,
        commitSha: null,
        htmlUrl: null,
      });
      expect(severityFor(r), band).toBe(sev);
    }
  });
});
