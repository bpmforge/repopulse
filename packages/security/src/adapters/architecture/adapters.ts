import { relativeTo, hasExtension, extractJson, type AdapterContext } from '../../scanners/code-health/adapters/types.js';
import type { ImportGraph } from './graph.js';

// Import-graph adapters (W10-03, FR-REG-5, CODE_HEALTH_SUITE §10).
//
// Same admission filter as the D11 tool adapters, and it is the reason this
// ticket ships two languages rather than three:
//
//   dependency-cruiser  ADMITTED — resolves local files statically, runs with
//                       --no-config, needs nothing installed.
//   grimp               ADMITTED — parses source rather than importing it; a
//                       third-party import that is not installed becomes an
//                       external module, not an error. (import-linter, which is
//                       built on grimp, is NOT admitted: it checks CONTRACTS
//                       from a config file, which is phase B.)
//   go list             REJECTED — needs module resolution and a populated
//                       module cache, i.e. an install at scan time. There is no
//                       Go toolchain in the image and adding one plus a warm
//                       cache is exactly what the filter forbids. Go coverage
//                       is deferred, and it is deferred for that reason rather
//                       than because Go's compiler already bans import cycles.
//
// Each adapter's ONLY job is producing a graph. Every detection lives in
// graph.ts, so "god module" means one thing across languages.

export interface GraphAdapter {
  key: string;
  version: string;
  license: string;
  detect(ctx: AdapterContext): boolean;
  command(ctx: AdapterContext): string[];
  /** Never throws: an unparseable run yields an empty graph and a reason. */
  parse(stdout: string, ctx: AdapterContext): { graph: ImportGraph; skipped: string[] };
}

const emptyGraph = (): ImportGraph => ({ edges: new Map(), files: new Map() });

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** Directories dependency-cruiser is pointed at — never the snapshot root. */
export function jsRoots(files: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    if (!JS_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
    const top = file.split('/')[0]!;
    // node_modules is excluded by the tool, but pointing it at the repo root
    // would still walk every vendored tree first. Naming the source roots
    // keeps the scan about this repository's own structure.
    if (top === 'node_modules' || top === 'dist' || top === 'build') continue;
    roots.add(file.includes('/') ? top : '.');
  }
  return [...roots].sort();
}

export const dependencyCruiserAdapter: GraphAdapter = {
  key: 'dependency_cruiser',
  // Pinned to 17.x: 18.x requires node >= 22 and the sandbox base ships 20.
  version: '17.4.3',
  license: 'MIT',
  detect: (ctx) => hasExtension(ctx.files, JS_EXTENSIONS) && jsRoots(ctx.files).length > 0,
  command: (ctx) => [
    'depcruise',
    // --no-config, because a config read out of the SNAPSHOT would let a
    // repository decide what our scanner reports about it.
    '--no-config',
    '--output-type',
    'json',
    ...jsRoots(ctx.files),
  ],
  parse(stdout, ctx) {
    const json = extractJson(stdout);
    if (!json) return { graph: emptyGraph(), skipped: ['no JSON on stdout'] };
    let document: { modules?: unknown };
    try {
      document = JSON.parse(json) as { modules?: unknown };
    } catch (error) {
      return { graph: emptyGraph(), skipped: [`unparseable JSON: ${String(error).slice(0, 120)}`] };
    }

    const graph = emptyGraph();
    const skipped: string[] = [];
    for (const entry of Array.isArray(document.modules) ? document.modules : []) {
      const module = entry as {
        source?: unknown;
        dependencies?: unknown;
        couldNotResolve?: unknown;
      };
      if (typeof module.source !== 'string') continue;
      const source = relativeTo(ctx.mountPath, module.source);
      const targets: string[] = [];
      for (const raw of Array.isArray(module.dependencies) ? module.dependencies : []) {
        const dependency = raw as { resolved?: unknown; couldNotResolve?: unknown };
        if (dependency.couldNotResolve === true) {
          // An import we cannot resolve is REPORTED rather than dropped: a
          // graph missing edges reports fewer cycles than the repo has.
          skipped.push(`${source}: unresolved import`);
          continue;
        }
        if (typeof dependency.resolved === 'string') {
          targets.push(relativeTo(ctx.mountPath, dependency.resolved));
        }
      }
      graph.edges.set(source, targets);
      graph.files.set(source, source);
    }
    return { graph, skipped };
  },
};

export const grimpAdapter: GraphAdapter = {
  key: 'grimp',
  version: '3.15',
  license: 'BSD-2-Clause',
  detect: (ctx) => ctx.files.some((file) => file.endsWith('/__init__.py') || file === '__init__.py'),
  // The driver lives in the IMAGE, not in the snapshot — a script read from
  // the repository would be the repository choosing what we run.
  command: (ctx) => ['python3', '/opt/scan-tools/grimp_graph.py', ctx.mountPath],
  parse(stdout, ctx) {
    const json = extractJson(stdout);
    if (!json) return { graph: emptyGraph(), skipped: ['no JSON on stdout'] };
    let document: { modules?: unknown; skipped?: unknown };
    try {
      document = JSON.parse(json) as { modules?: unknown; skipped?: unknown };
    } catch (error) {
      return { graph: emptyGraph(), skipped: [`unparseable JSON: ${String(error).slice(0, 120)}`] };
    }

    const graph = emptyGraph();
    const modules = (document.modules ?? {}) as Record<string, unknown>;
    for (const [module, imports] of Object.entries(modules)) {
      graph.edges.set(module, Array.isArray(imports) ? (imports as string[]) : []);
      graph.files.set(module, moduleFile(module, ctx.files));
    }

    const skipped = (Array.isArray(document.skipped) ? document.skipped : []).map((entry) => {
      const record = entry as { package?: unknown; reason?: unknown };
      return `${String(record.package)}: ${String(record.reason)}`;
    });
    return { graph, skipped };
  },
};

/**
 * Dotted module name -> the file that defines it.
 *
 * `pkg.a` is `pkg/a.py` unless it is a package, in which case it is
 * `pkg/a/__init__.py`. Checked against the snapshot's file list rather than
 * assumed, because a finding that points at a file which does not exist sends
 * a reader nowhere and breaks the hotspot lookup that prices it.
 */
function moduleFile(module: string, files: readonly string[]): string {
  const base = module.split('.').join('/');
  const candidates = [`${base}.py`, `${base}/__init__.py`];
  return candidates.find((candidate) => files.includes(candidate)) ?? `${base}.py`;
}

export const ARCHITECTURE_ADAPTERS: readonly GraphAdapter[] = [
  dependencyCruiserAdapter,
  grimpAdapter,
];

export function architectureAdapter(key: string): GraphAdapter | undefined {
  return ARCHITECTURE_ADAPTERS.find((adapter) => adapter.key === key);
}
