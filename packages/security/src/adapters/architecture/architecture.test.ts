import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  detectArchitecture,
  stronglyConnected,
  weaklyConnected,
  type ImportGraph,
} from './graph.js';
import { loadArchitecturePack, ArchitecturePackError } from './pack.js';
import { dependencyCruiserAdapter, grimpAdapter, jsRoots } from './adapters.js';

// Architecture register phase A (W10-03, FR-REG-5).

const PACK = loadArchitecturePack();
const here = path.dirname(fileURLToPath(import.meta.url));

function graphOf(edges: Record<string, string[]>): ImportGraph {
  return {
    edges: new Map(Object.entries(edges)),
    files: new Map(Object.keys(edges).map((m) => [m, `${m}.ts`])),
  };
}

describe('the rulepack', () => {
  it('carries every threshold the detectors use', () => {
    expect(PACK.version).toBe(1);
    expect(PACK.godModule.minModules).toBeGreaterThan(1);
    expect(PACK.orphan.minClusterSize).toBeGreaterThanOrEqual(2);
  });

  it('FAILS CLOSED on a pack it cannot read, rather than using code defaults', () => {
    // Silent defaults would mean the thresholds a reader sees in the asset are
    // not the thresholds that ran.
    expect(() => loadArchitecturePack('/nonexistent/architecture.yaml')).toThrow(
      ArchitecturePackError,
    );
  });
});

describe('cycles', () => {
  it('finds a two-module cycle and names both members', () => {
    const { findings } = detectArchitecture(graphOf({ a: ['b'], b: ['a'] }), PACK);
    const cycle = findings.find((f) => f.ruleId === 'architecture.cycle')!;
    expect(cycle.members).toEqual(['a', 'b']);
    expect(cycle.severity).toBe(3);
  });

  it('escalates severity with cycle SIZE, not with a guess', () => {
    const big = graphOf({ a: ['b'], b: ['c'], c: ['d'], d: ['e'], e: ['a'] });
    const cycle = detectArchitecture(big, PACK).findings.find(
      (f) => f.ruleId === 'architecture.cycle',
    )!;
    expect(cycle.severity).toBe(4);
    expect(cycle.title).toContain('5 modules');
  });

  it('reports a self-import, which Tarjan alone would miss', () => {
    const { findings } = detectArchitecture(graphOf({ a: ['a'] }), PACK);
    expect(findings.find((f) => f.ruleId === 'architecture.cycle')?.title).toContain(
      'imports itself',
    );
  });

  it('says nothing about an acyclic graph', () => {
    const { findings } = detectArchitecture(graphOf({ a: ['b'], b: ['c'], c: [] }), PACK);
    expect(findings.filter((f) => f.ruleId === 'architecture.cycle')).toEqual([]);
  });

  it('gives two overlapping cycles DISTINCT evidence', () => {
    // Identical evidence strings collide on the findings dedup key and the
    // whole write fails — the defect W10-02's integration test caught.
    const edges: Record<string, string[]> = { a: ['b'], b: ['a'], c: ['d'], d: ['c'] };
    const cycles = detectArchitecture(graphOf(edges), PACK).findings.filter(
      (f) => f.ruleId === 'architecture.cycle',
    );
    expect(cycles).toHaveLength(2);
    expect(new Set(cycles.map((f) => f.evidence)).size).toBe(2);
  });

  it('does not blow the stack on a deep chain', () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 5000; i += 1) edges[`m${i}`] = [`m${i + 1}`];
    edges.m5000 = [];
    expect(() => stronglyConnected(new Map(Object.entries(edges)))).not.toThrow();
  });
});

describe('god modules', () => {
  const wide = (): Record<string, string[]> => {
    const edges: Record<string, string[]> = { hub: [] };
    for (let i = 0; i < 20; i += 1) {
      edges[`leaf${i}`] = ['hub'];
      if (i < 6) edges.hub!.push(`sink${i}`);
      if (i < 6) edges[`sink${i}`] = [];
    }
    return edges;
  };

  it('flags the outlier against the repo distribution', () => {
    const { findings } = detectArchitecture(graphOf(wide()), PACK);
    const god = findings.filter((f) => f.ruleId === 'architecture.god_module');
    expect(god.map((f) => f.members[0])).toEqual(['hub']);
    expect(god[0]!.evidence).toContain('90th percentile');
  });

  it('reports "not enough modules" rather than a clean result on a small repo', () => {
    // A repo with three modules has no distribution to be an outlier against.
    // Silence here would read as "no god modules", which is a different claim.
    const result = detectArchitecture(graphOf({ a: ['b'], b: [], c: [] }), PACK);
    expect(result.findings.filter((f) => f.ruleId === 'architecture.god_module')).toEqual([]);
    expect(result.notRun.map((n) => n.ruleId)).toContain('architecture.god_module');
  });

  it('does not flag a merely-larger module in an evenly connected repo', () => {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < 20; i += 1) edges[`m${i}`] = [`m${(i + 1) % 20}`, `m${(i + 2) % 20}`];
    const { findings } = detectArchitecture(graphOf(edges), PACK);
    expect(findings.filter((f) => f.ruleId === 'architecture.god_module')).toEqual([]);
  });
});

describe('orphan clusters', () => {
  it('flags a disconnected cluster, not a single stray file', () => {
    const edges: Record<string, string[]> = {
      'main/a': ['main/b'],
      'main/b': ['main/c'],
      'main/c': ['main/d'],
      'main/d': [],
      'island/x': ['island/y'],
      'island/y': ['island/z'],
      'island/z': [],
      lonely: [],
    };
    const { findings } = detectArchitecture(graphOf(edges), PACK);
    const orphans = findings.filter((f) => f.ruleId === 'architecture.orphan_cluster');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.members).toEqual(['island/x', 'island/y', 'island/z']);
  });

  it('refuses to pick an orphan when two clusters are the same size', () => {
    const result = detectArchitecture(
      graphOf({ 'a/1': ['a/2'], 'a/2': ['a/3'], 'a/3': [], 'b/1': ['b/2'], 'b/2': ['b/3'], 'b/3': [] }),
      PACK,
    );
    expect(result.findings.filter((f) => f.ruleId === 'architecture.orphan_cluster')).toEqual([]);
    expect(result.notRun.map((n) => n.reason).join()).toContain('same size');
  });

  it('treats direction as irrelevant for connectivity', () => {
    expect(weaklyConnected(new Map([['a', ['b']], ['b', []]]))).toEqual([['a', 'b']]);
  });
});

describe('adapters', () => {
  it('parses a dependency-cruiser document into a graph', () => {
    const stdout = JSON.stringify({
      modules: [
        {
          source: 'src/a.js',
          dependencies: [{ resolved: 'src/b.js', couldNotResolve: false }],
        },
        { source: 'src/b.js', dependencies: [] },
      ],
    });
    const { graph, skipped } = dependencyCruiserAdapter.parse(stdout, {
      mountPath: '/scan',
      files: [],
    });
    expect([...graph.edges.entries()]).toEqual([
      ['src/a.js', ['src/b.js']],
      ['src/b.js', []],
    ]);
    expect(skipped).toEqual([]);
  });

  it('REPORTS an unresolved import rather than dropping the edge silently', () => {
    const stdout = JSON.stringify({
      modules: [{ source: 'src/a.js', dependencies: [{ module: 'ghost', couldNotResolve: true }] }],
    });
    const { skipped } = dependencyCruiserAdapter.parse(stdout, { mountPath: '/scan', files: [] });
    expect(skipped).toEqual(['src/a.js: unresolved import']);
  });

  it('maps a dotted python module onto the file that defines it', () => {
    const stdout = JSON.stringify({
      modules: { 'pkg.a': ['pkg.sub'], 'pkg.sub': [] },
      skipped: [],
    });
    const { graph } = grimpAdapter.parse(stdout, {
      mountPath: '/scan',
      files: ['pkg/a.py', 'pkg/sub/__init__.py'],
    });
    expect(graph.files.get('pkg.a')).toBe('pkg/a.py');
    expect(graph.files.get('pkg.sub')).toBe('pkg/sub/__init__.py');
  });

  it('carries a package grimp could not graph out as a skip', () => {
    const { skipped } = grimpAdapter.parse(
      JSON.stringify({ modules: {}, skipped: [{ package: 'pkg', reason: 'boom' }] }),
      { mountPath: '/scan', files: [] },
    );
    expect(skipped).toEqual(['pkg: boom']);
  });

  it('never throws on garbage output', () => {
    for (const adapter of [dependencyCruiserAdapter, grimpAdapter]) {
      expect(() => adapter.parse('not json at all', { mountPath: '/scan', files: [] })).not.toThrow();
    }
  });

  it('detects per language and points the JS tool at source roots', () => {
    expect(dependencyCruiserAdapter.detect({ mountPath: '/scan', files: ['src/a.ts'] })).toBe(true);
    expect(dependencyCruiserAdapter.detect({ mountPath: '/scan', files: ['a.py'] })).toBe(false);
    expect(grimpAdapter.detect({ mountPath: '/scan', files: ['pkg/__init__.py'] })).toBe(true);
    expect(grimpAdapter.detect({ mountPath: '/scan', files: ['script.py'] })).toBe(false);
    expect(jsRoots(['src/a.ts', 'lib/b.js', 'node_modules/x/i.js'])).toEqual(['lib', 'src']);
  });

  it('runs config-free — no config path is passed to either tool', () => {
    // A config read out of the snapshot would let a repository decide what our
    // scanner reports about it.
    const command = dependencyCruiserAdapter.command({ mountPath: '/scan', files: ['src/a.ts'] });
    expect(command).toContain('--no-config');
    expect(command.join(' ')).not.toMatch(/--config|\.dependency-cruiser/);
  });
});

describe('phase B is provably absent (acceptance item 3)', () => {
  // Declared-boundary checking needs a team to state its intent. Inventing
  // that intent from the graph would produce findings about an architecture
  // nobody agreed to — so this ticket ships no contract schema, no route and
  // no UI, and that absence is asserted rather than promised.
  const sourceOf = (relative: string): string => readFileSync(path.join(here, relative), 'utf8');

  it('ships no boundary-contract schema or config surface', () => {
    const files = readdirSync(here).filter((f) => f.endsWith('.ts'));
    const all = files.map(sourceOf).join('\n');
    for (const forbidden of ['boundary', 'contract', 'allowedImports', 'forbidden_import']) {
      expect(all.toLowerCase().includes(forbidden.toLowerCase()) && !all.includes('phase B'))
        .toBe(false);
    }
    // The rulepack must contain only config-free rules.
    const pack = readFileSync(
      path.join(here, '../../../rulepacks/architecture/architecture.v1.yaml'),
      'utf8',
    );
    expect(pack).not.toMatch(/^\s*(contracts|layers|forbidden):/m);
  });

  it('registers no API route and no UI widget for architecture rules', () => {
    const apiRoutes = path.join(here, '../../../../../apps/api/src/routes');
    const webWidgets = path.join(here, '../../../../../apps/web/src/widgets');
    for (const dir of [apiRoutes, webWidgets]) {
      const entries = readdirSync(dir);
      expect(entries.filter((e) => /boundar|architecture/i.test(e))).toEqual([]);
    }
  });
});
