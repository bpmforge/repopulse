import { describe, expect, it } from 'vitest';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@repopulse/shared';
import { likeContains, listFilters } from './index.js';
import { chainsComputed, cveRows } from '../security/index.js';

// W20-13: free-text search (FND-20), the chain filter (FND-46), the CVE
// table's reachability (FND-28) and chains_computed (FND-60).

const dialect = new PgDialect();
const render = (q: Record<string, string>) => {
  const { filters } = listFilters({} as Database, 1, q);
  return dialect.sqlToQuery(and(...filters)!);
};

describe('free-text search (FND-20)', () => {
  it('matches title, file, CVE id and rule id, case-blind', () => {
    const q = render({ q: '  lodash ' });
    expect(q.sql.match(/ilike/g)).toHaveLength(4);
    expect(q.params.filter((p) => p === '%lodash%')).toHaveLength(4);
  });

  it('treats % and _ as text, not wildcards', () => {
    expect(likeContains('50%_off')).toBe('%50\\%\\_off%');
  });

  it('adds nothing for an empty search', () => {
    expect(render({ q: '   ' }).sql).not.toMatch(/ilike/);
  });
});

describe('chain filter (FND-46)', () => {
  it('narrows to one attack chain', () => {
    const q = render({ chain_id: 'ch-1' });
    expect(q.sql).toMatch(/"chain_id" = \$/);
    expect(q.params).toContain('ch-1');
  });
});

describe('CVE rows carry reachability (FND-28)', () => {
  it('reads the tier the scanner stored, null when there is none', () => {
    const base = {
      dimension: 'dependency',
      severity: 3,
      scannerKey: 'dependency_cve',
      ruleId: null,
      experimental: false,
    };
    const rows = cveRows([
      {
        ...base,
        id: 1,
        title: 'CVE-1 in a 1.0',
        cveId: 'CVE-1',
        yields: { reachability: 'symbol_reachable' },
      },
      { ...base, id: 2, title: 'CVE-2 in b 1.0', cveId: 'CVE-2', yields: null },
    ]);
    expect(rows.map((r) => r.reachability)).toEqual(['symbol_reachable', null]);
  });
});

describe('chainsComputed (FND-60)', () => {
  it('is true once the chainer has a succeeded run', () => {
    expect(chainsComputed({ status: 'succeeded' })).toBe(true);
    expect(chainsComputed({ status: 'failed' })).toBe(false);
    expect(chainsComputed(undefined)).toBe(false);
  });
});
