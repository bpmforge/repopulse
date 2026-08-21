import { readSnapshotSources } from '../snapshot/sources.js';
import type { ScopeEcosystem } from './scope.js';
import type { DepScope, UsageEvidence, UsageVerdict } from './types.js';

// V2 — usage detection (W8-13, SECURITY_SUITE.md §3.6, FR-SEC-13).
//
// "Is this vulnerable package imported at all?" A never-imported dependency is
// a DIFFERENT FACT from a used one, and worth stamping on the finding — but it
// is a weaker fact than it sounds, and the wording here is the part of this
// tier that matters most.
//
// NOT IMPORTED IS NOT NOT EXPLOITABLE. A package the repository never names
// can still be loaded by a plugin loader, a framework's convention scan, a
// build step, a config file, or `require(someVariable)`. All this tier can
// honestly say is "no import statement in this repository's own sources names
// it", and every sentence it produces says exactly that. It PROPOSES a VEX
// justification for a human; it never dismisses.
//
// THE FAIL-SAFE DIRECTION IS 'unknown'. Three cases below answer 'unknown'
// rather than 'not_imported', because a false not-imported would propose
// not_affected on a live vulnerability while a false unknown only leaves a
// finding priced as it already was:
//   1. TRANSITIVE dependencies. The snapshot is a source tarball with no
//      installed tree, so the import scan sees only files the repository
//      wrote. `ms` is never named there and is nonetheless fully reachable
//      through `debug` — absence proves nothing about a package nothing was
//      supposed to name.
//   2. PYPI names that do not match their import name. `pyyaml` is `import
//      yaml`, `beautifulsoup4` is `bs4`, `pillow` is `PIL`. The mapping lives
//      in the installed distribution's metadata, which a source tarball does
//      not contain, so a pypi package we cannot find is unknown rather than
//      absent.
//   3. A TRUNCATED walk. If the source reader hit its cap, the files that
//      would have named the package may be the ones it did not read.
//
// npm is the ecosystem where absence is genuinely informative: the import
// specifier IS the package name, by the resolution algorithm, so a direct
// dependency no file names is a direct dependency no file loads by name.

export interface ImportIndex {
  /** Import specifiers found, normalized to package names, per ecosystem. */
  byEcosystem: Map<ScopeEcosystem, Map<string, UsageEvidence[]>>;
  /** True when the source reader hit a cap — see fail-safe case 3. */
  truncated: boolean;
  filesScanned: number;
}

/** JS/TS: `import x from 'p'`, `export … from 'p'`, `require('p')`, `import('p')`. */
const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/g;
/** Python: `import a.b`, `from a.b import c`. Relative (`from .x`) is skipped. */
const PY_IMPORT = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*))/gm;
/** Go: a quoted path inside an import block, or a single-line import. */
const GO_IMPORT = /^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"\n]+)"\s*$/gm;

const ECOSYSTEM_BY_EXTENSION: { pattern: RegExp; ecosystem: ScopeEcosystem; regex: RegExp }[] = [
  { pattern: /\.(js|jsx|mjs|cjs|ts|tsx)$/, ecosystem: 'npm', regex: JS_IMPORT },
  { pattern: /\.py$/, ecosystem: 'pypi', regex: PY_IMPORT },
  { pattern: /\.go$/, ecosystem: 'go', regex: GO_IMPORT },
];

/**
 * The package a specifier names, or null when it names no package.
 *
 * Relative and absolute specifiers are not packages, and counting `./helpers`
 * as one would make every repository look like it imported everything.
 */
export function packageOfSpecifier(ecosystem: ScopeEcosystem, specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (ecosystem === 'npm') {
    if (specifier.startsWith('node:')) return null;
    const parts = specifier.split('/');
    // A scoped package is TWO segments: `@scope/name/sub/path` is the package
    // `@scope/name`, and taking one segment would make every scoped import
    // resolve to the scope.
    return specifier.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
  }
  if (ecosystem === 'pypi') {
    // `import a.b.c` uses the top-level module, which is the name the
    // distribution is usually — not always — published under. See fail-safe 2.
    return specifier.split('.')[0]!;
  }
  // Go import paths ARE module paths (or a package inside one), so the whole
  // path is kept and prefix-matched at query time.
  return specifier;
}

/** Builds the import index for a snapshot tree. */
export function scanImports(snapshotDir: string): ImportIndex {
  const { files, truncated } = readSnapshotSources(snapshotDir);
  const byEcosystem = new Map<ScopeEcosystem, Map<string, UsageEvidence[]>>();

  for (const file of files) {
    const rule = ECOSYSTEM_BY_EXTENSION.find((entry) => entry.pattern.test(file.path));
    if (!rule) continue;
    const index = byEcosystem.get(rule.ecosystem) ?? new Map<string, UsageEvidence[]>();
    byEcosystem.set(rule.ecosystem, index);

    // Line offsets computed once per file: an import scan that re-split the
    // source for every match would be quadratic on a large file.
    const lineStarts = lineOffsets(file.source);
    rule.regex.lastIndex = 0;
    for (let match = rule.regex.exec(file.source); match; match = rule.regex.exec(file.source)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;
      const name = packageOfSpecifier(rule.ecosystem, specifier);
      if (name === null) continue;
      const key = rule.ecosystem === 'pypi' ? name.toLowerCase() : name;
      const line = lineAt(lineStarts, match.index);
      const evidence: UsageEvidence = {
        file: file.path,
        line,
        quote: file.source
          .slice(lineStarts[line - 1]!, lineStarts[line] ?? file.source.length)
          .trim()
          .slice(0, 200),
      };
      index.set(key, [...(index.get(key) ?? []), evidence]);
    }
  }

  return { byEcosystem, truncated, filesScanned: files.length };
}

function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) {
    offsets.push(at + 1);
  }
  return offsets;
}

/** 1-based line for a character offset, by binary search over line starts. */
function lineAt(offsets: readonly number[], index: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** How many import statements name this package. Evidence, capped for storage. */
const MAX_EVIDENCE = 3;

/**
 * V2's verdict for one vulnerable component.
 *
 * `scope` is an INPUT because the answer depends on it: absence is only
 * informative for a direct dependency (see the fail-safe note above).
 */
export function usageFor(
  imports: ImportIndex,
  ecosystem: ScopeEcosystem | null,
  packageName: string,
  scope: DepScope | null,
): UsageVerdict {
  if (!ecosystem) {
    return {
      status: 'unknown',
      unknownReason: 'no import scanner for this package ecosystem',
      evidence: [],
    };
  }

  const index = imports.byEcosystem.get(ecosystem) ?? new Map<string, UsageEvidence[]>();
  const found = matchesFor(index, ecosystem, packageName);
  if (found.length > 0) {
    return { status: 'imported', unknownReason: null, evidence: found.slice(0, MAX_EVIDENCE) };
  }

  if (imports.truncated) {
    return {
      status: 'unknown',
      unknownReason:
        'the source walk hit its file cap, so the files that would name this package ' +
        'may be among the ones it did not read',
      evidence: [],
    };
  }
  if (scope === null || scope.kind !== 'prod-direct') {
    return {
      status: 'unknown',
      unknownReason:
        scope?.kind === 'dev'
          ? 'a dev dependency is loaded by tooling that the repository does not import by name'
          : 'a transitive dependency is reached through its parent, so this repository ' +
            'was never expected to name it',
      evidence: [],
    };
  }
  if (ecosystem === 'pypi') {
    return {
      status: 'unknown',
      unknownReason:
        'a pypi distribution may be imported under a different name than it is published ' +
        'under (pyyaml is imported as yaml), and the mapping is not in a source tarball',
      evidence: [],
    };
  }

  return { status: 'not_imported', unknownReason: null, evidence: [] };
}

/** Import records naming this package, by the matching rule for its ecosystem. */
function matchesFor(
  index: Map<string, UsageEvidence[]>,
  ecosystem: ScopeEcosystem,
  packageName: string,
): UsageEvidence[] {
  if (ecosystem === 'go') {
    // A Go import path is the module path OR a package inside it, so this is a
    // prefix test rather than an equality test: importing
    // `github.com/x/y/internal/z` is importing module `github.com/x/y`. The
    // boundary check stops `github.com/x/yy` matching `github.com/x/y`.
    const hits: UsageEvidence[] = [];
    for (const [specifier, evidence] of index) {
      if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
        hits.push(...evidence);
      }
    }
    return hits;
  }
  if (ecosystem === 'pypi') {
    // PEP 503 comparison, plus the near-universal `-`/`_` swap between a
    // distribution name and its module (`python-dateutil` -> `dateutil` is NOT
    // covered by this and correctly falls through to 'unknown').
    const normalized = packageName.toLowerCase().replace(/[-_.]+/g, '_');
    return index.get(normalized) ?? index.get(normalized.replace(/_/g, '-')) ?? [];
  }
  return index.get(packageName) ?? [];
}
