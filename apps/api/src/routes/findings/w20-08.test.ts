import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { dependencyEvidenceOf, dismissNeedsAdmin, statusesFrom } from './index.js';
import { cveRows } from '../security/index.js';
import { ruleIdMatch } from '../rules/index.js';

// W20-08: the pure halves of the finding payload (FND-57), the CVE table
// (FND-56), the dismiss gate (FND-66), the status filter (FND-49) and the
// tool-rule evidence match (FND-59).

describe('dependencyEvidenceOf (FND-57)', () => {
  it('sends what the scanner worked out, and drops shapes it does not know', () => {
    expect(
      dependencyEvidenceOf({
        dimension: 'dependency',
        scannerKey: 'dependency_cve',
        yields: {
          reachability: 'symbol_reachable',
          usage: 'calls merge',
          call_sites: [{ file: 'src/a.ts', line: 3, symbol: 'merge' }, 'junk', { line: 4 }],
          usage_evidence: [{ file: 'src/b.ts', line: null, quote: 'import _ from "lodash"' }],
          dep_scope: { kind: 'prod', depth: 2 },
          epss: 0.12,
          aliases: ['GHSA-1', 7],
        },
      }),
    ).toEqual({
      reachability: 'symbol_reachable',
      usage: 'calls merge',
      call_sites: [{ file: 'src/a.ts', line: 3, symbol: 'merge' }],
      usage_evidence: [{ file: 'src/b.ts', line: null, quote: 'import _ from "lodash"' }],
      scope: { kind: 'prod', depth: 2 },
      epss: 0.12,
      aliases: ['GHSA-1'],
    });
  });

  it('is null for anything that is not a dependency finding', () => {
    expect(
      dependencyEvidenceOf({ dimension: 'sast', scannerKey: 'semgrep', yields: {} }),
    ).toBeNull();
    expect(
      dependencyEvidenceOf({ dimension: 'dependency', scannerKey: 'dependency_cve', yields: null }),
    ).toBeNull();
  });
});

describe('cveRows (FND-56)', () => {
  const base = {
    dimension: 'dependency',
    severity: 3,
    scannerKey: 'dependency_cve',
    cveId: null,
    ruleId: null,
    yields: null,
    experimental: false,
  };

  it('lists dependency and image CVEs by finding, worst and known-exploited first', () => {
    const rows = cveRows([
      { ...base, id: 1, title: 'CVE-1 in lodash 4.17.20', cveId: 'CVE-1' },
      {
        ...base,
        id: 2,
        title: 'CVE-2 in nginx:1.25 (openssl 3.0.1)',
        cveId: 'CVE-2',
        severity: 5,
        scannerKey: 'container_image',
        yields: { kev: true },
      },
      { ...base, id: 3, title: 'GHSA-x in left-pad 1.0.0', ruleId: 'GHSA-x' },
      { ...base, id: 4, title: 'shadow', cveId: 'CVE-4', experimental: true },
      { ...base, id: 5, title: 'not a cve', dimension: 'sast', cveId: 'CVE-5' },
    ]);
    expect(rows.map((r) => r.finding_id)).toEqual([2, 1, 3]);
    expect(rows[0]).toEqual({
      finding_id: 2,
      cve_id: 'CVE-2',
      package: 'openssl 3.0.1',
      severity: 5,
      kev: true,
      scanner_key: 'container_image',
      reachability: null,
    });
    expect(rows[1]!.package).toBe('lodash 4.17.20');
    expect(rows[2]!.cve_id).toBe('GHSA-x');
  });
});

describe('dismissNeedsAdmin (FND-66)', () => {
  it('holds back high and critical findings, and findings on an open pull request', () => {
    expect(dismissNeedsAdmin({ severity: 4, prState: null })).toBe(true);
    expect(dismissNeedsAdmin({ severity: 3, prState: 'open' })).toBe(true);
    expect(dismissNeedsAdmin({ severity: 3, prState: 'merged' })).toBe(false);
    expect(dismissNeedsAdmin({ severity: 2, prState: null })).toBe(false);
  });
});

describe('statusesFrom (FND-49)', () => {
  it('reads active, a single status and a comma list; drops junk', () => {
    expect(statusesFrom('active')).toEqual(['open', 'confirmed']);
    expect(statusesFrom('open')).toEqual(['open']);
    expect(statusesFrom('open,dismissed,bogus')).toEqual(['open', 'dismissed']);
  });
});

describe('ruleIdMatch (FND-59)', () => {
  const dialect = new PgDialect();
  it('a tool row counts its own per-check findings as evidence', () => {
    const q = dialect.sqlToQuery(ruleIdMatch('tool.checkov'));
    expect(q.sql).toMatch(/like/i);
    expect(q.params).toEqual(['tool.checkov', 'tool.checkov.%']);
  });
  it('any other rule matches its id exactly', () => {
    const q = dialect.sqlToQuery(ruleIdMatch('perf.n-plus-one'));
    expect(q.sql).not.toMatch(/like/i);
    expect(q.params).toEqual(['perf.n-plus-one']);
  });
});
