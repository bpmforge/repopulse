import { describe, expect, it } from 'vitest';
import {
  exposureWhy,
  importExposureFor,
  indexImportGraph,
  looksLikeEntryPoint,
  parseImportGraph,
  type ImportGraphSnapshot,
} from './import-graph.js';

// The persisted import graph and the exposure it implies (W18-25).

const snapshot: ImportGraphSnapshot = {
  version: 1,
  commitSha: 'abc1234def',
  complete: true,
  extensions: ['.ts', '.js'],
  files: ['src/a.ts', 'src/b.ts', 'src/util.ts', 'src/dead.ts', 'src/index.ts', 'src/aliased.ts'],
  edges: [
    [0, 2, ['helper']],
    [1, 2, null],
    [4, 0, ['a']],
    // A self-edge must not count as an importer.
    [2, 2, ['x']],
  ],
  aliased: [5],
};

describe('importExposureFor', () => {
  const graph = indexImportGraph(snapshot);

  it('counts DISTINCT importing files', () => {
    expect(importExposureFor(graph, 'src/util.ts')).toEqual({ state: 'imported', fanIn: 2 });
    expect(importExposureFor(graph, 'src/a.ts')).toEqual({ state: 'imported', fanIn: 1 });
  });

  it('calls a file nothing imports an orphan, unless its path says entry point', () => {
    expect(importExposureFor(graph, 'src/dead.ts').state).toBe('orphan');
    expect(importExposureFor(graph, 'src/index.ts').state).toBe('entry');
  });

  it('does not call a file an orphan when an unresolved specifier may reach it', () => {
    expect(importExposureFor(graph, 'src/aliased.ts').state).toBe('aliased');
  });

  it('degrades to a neutral state when the graph cannot say', () => {
    expect(importExposureFor(null, 'src/a.ts').state).toBe('absent');
    expect(importExposureFor(graph, 'app/models.py').state).toBe('unindexed');
    expect(importExposureFor(graph, 'src/new-since-snapshot.ts').state).toBe('missing');
    const capped = indexImportGraph({ ...snapshot, complete: false });
    // Even the file with a real count: on a capped read it is a lower bound.
    expect(importExposureFor(capped, 'src/util.ts')).toEqual({ state: 'incomplete', fanIn: null });
    expect(importExposureFor(capped, 'src/dead.ts').state).toBe('incomplete');
  });
});

describe('exposureWhy', () => {
  it('reads as a sentence a person can argue with', () => {
    expect(exposureWhy({ state: 'imported', fanIn: 14 })).toBe('imported by 14 modules');
    expect(exposureWhy({ state: 'imported', fanIn: 1 })).toBe('imported by 1 module');
    expect(exposureWhy({ state: 'orphan', fanIn: 0 })).toBe('nothing imports this file');
    for (const state of [
      'entry',
      'aliased',
      'incomplete',
      'unindexed',
      'missing',
      'absent',
    ] as const) {
      expect(exposureWhy({ state, fanIn: null })).toMatch(/not adjusted/);
    }
  });
});

describe('looksLikeEntryPoint', () => {
  it('recognises runtime and framework entry points, not ordinary modules or tests', () => {
    for (const p of [
      'src/index.ts',
      'apps/web/src/main.tsx',
      'vite.config.ts',
      'src/routes/x.ts',
      'bin/cli.js',
    ]) {
      expect(looksLikeEntryPoint(p)).toBe(true);
    }
    for (const p of [
      'src/lib/money.ts',
      'src/lib/money.test.ts',
      'src/domain/indexer.ts',
      'apps/api/src/lib/problem.ts',
    ]) {
      expect(looksLikeEntryPoint(p)).toBe(false);
    }
  });
});

describe('parseImportGraph', () => {
  it('round-trips a valid snapshot', () => {
    expect(parseImportGraph(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('reads a malformed row as NO graph, never as a graph of orphans', () => {
    expect(parseImportGraph(null)).toBeNull();
    expect(parseImportGraph({ ...snapshot, version: 2 })).toBeNull();
    expect(parseImportGraph({ ...snapshot, edges: [[0, 99, null]] })).toBeNull();
    expect(parseImportGraph({ ...snapshot, edges: [[0, 1, [3]]] })).toBeNull();
    expect(parseImportGraph({ ...snapshot, complete: 'yes' })).toBeNull();
  });
});
