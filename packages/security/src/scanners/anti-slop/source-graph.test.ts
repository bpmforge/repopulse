import { describe, expect, it } from 'vitest';
import { buildImportGraph } from './source-graph.js';

// The persisted import graph's builder (W18-25): file-to-file edges with the
// names taken, from the same lexer every fast-lane rule uses.

describe('buildImportGraph', () => {
  const sources = [
    { path: 'src/util.ts', source: 'export function helper() {}\nexport const other = 1;\n' },
    {
      path: 'src/a.ts',
      source:
        "import { helper } from './util.js';\nimport { other } from './util';\nimport x from 'lodash';\n",
    },
    { path: 'src/b.ts', source: "import * as u from './util';\n// import { gone } from './a';\n" },
    { path: 'src/c.ts', source: "const u = require('./util');\n" },
    { path: 'src/register.ts', source: "import './widgets';\nimport type { T } from './a';\n" },
    { path: 'src/widgets/index.ts', source: 'register();\n' },
    { path: 'src/self.ts', source: "import { me } from './self';\n" },
    { path: 'src/aliased.ts', source: 'export const reachable = 1;\n' },
    { path: 'src/consumer.ts', source: "import { reachable } from '@/lib/aliased';\n" },
    { path: 'app/models.py', source: 'from .util import helper\n' },
  ];
  const graph = buildImportGraph(sources);
  const edge = (from: string, to: string) =>
    graph.edges.find(([f, t]) => graph.files[f] === from && graph.files[t] === to);

  it('indexes JS/TS files only, sorted, so a re-run is byte-identical', () => {
    expect(graph.files).toEqual([...graph.files].sort());
    expect(graph.files).not.toContain('app/models.py');
    expect(JSON.stringify(buildImportGraph([...sources].reverse()))).toBe(JSON.stringify(graph));
  });

  it('merges every import of one module into one edge with the names taken', () => {
    expect(edge('src/a.ts', 'src/util.ts')?.[2]).toEqual(['helper', 'other']);
  });

  it('records namespace imports and require() as "the whole module"', () => {
    expect(edge('src/b.ts', 'src/util.ts')?.[2]).toBeNull();
    expect(edge('src/c.ts', 'src/util.ts')?.[2]).toBeNull();
  });

  it('records a side-effect import as an edge that takes no name', () => {
    expect(edge('src/register.ts', 'src/widgets/index.ts')?.[2]).toEqual([]);
    expect(edge('src/register.ts', 'src/a.ts')?.[2]).toEqual(['T']);
  });

  it('ignores commented-out imports and self-imports', () => {
    expect(edge('src/b.ts', 'src/a.ts')).toBeUndefined();
    expect(edge('src/self.ts', 'src/self.ts')).toBeUndefined();
  });

  it('marks a file an unresolved specifier may name as aliased, not unreferenced', () => {
    const aliased = graph.aliased.map((i) => graph.files[i]);
    expect(aliased).toContain('src/aliased.ts');
    expect(aliased).not.toContain('src/util.ts');
  });
});
