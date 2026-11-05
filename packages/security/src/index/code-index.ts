import { createHash } from 'node:crypto';
import { extractGraph, languageForPath } from '@bpmforge/lodestone/graph';
import { SnapshotReader } from './snapshot.js';

// The code map (W22-01, decision 4: names and lines only).
//
// Lodestone's graph extractor runs over the scan snapshot while it exists and
// this module keeps what decision 4 allows: per file a path, a content hash,
// the language and which tier read it; definitions (name, kind, line span);
// references and call edges to names the repository itself defines; and import
// edges. NO SOURCE TEXT leaves this function: every field is a name, a path, a
// number or a hash, and code-index.test.ts asserts it on a fixture tree.
//
// Not a second indexer: the parsing, the symbol table and the call sites are
// Lodestone's (bpmforge/lodestone, MIT, vendored at a pinned commit under
// vendor/lodestone). This module only walks the snapshot, filters and caps.

/** Which Lodestone produced a map; bump with the vendored tarball. */
export const CODE_INDEX_EXTRACTOR = 'lodestone@bd1e554';

/** Files Lodestone reads: its grammars, plus the regex tier for Kotlin and Swift. */
const REGEX_TIER = /\.(kt|kts|swift)$/i;
/** Generated or bundled files: indexing them adds names nobody wrote. */
const GENERATED = /(\.min\.[cm]?js|\.bundle\.js|\.pb\.go|_pb2\.py|\.generated\.\w+|\.d\.ts)$/i;

export const CODE_INDEX_CAPS = {
  /** Files parsed; the snapshot walk itself stops at 20,000. */
  files: 20_000,
  defs: 500_000,
  /** Grouped rows (one per file and name). */
  refs: 1_000_000,
  calls: 1_000_000,
  imports: 200_000,
} as const;

export interface CodeIndexFile {
  path: string;
  /** sha256 of the file text with '\n' line ends. */
  contentHash: string;
  language: string | null;
  method: 'tree-sitter' | 'regex';
  lineCount: number;
}

export interface CodeIndexDef {
  path: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface CodeIndexRef {
  path: string;
  symbol: string;
  lines: number[];
}

export interface CodeIndexCall {
  path: string;
  caller: string;
  callee: string;
  line: number;
}

export interface CodeIndexImport {
  path: string;
  target: string;
  line: number;
}

export interface CodeIndex {
  extractor: string;
  files: CodeIndexFile[];
  defs: CodeIndexDef[];
  refs: CodeIndexRef[];
  calls: CodeIndexCall[];
  imports: CodeIndexImport[];
  /** A cap stopped the walk or a list; what was kept is what the lists hold. */
  truncated: boolean;
  buildMs: number;
}

export function isIndexable(rel: string): boolean {
  if (GENERATED.test(rel)) return false;
  return languageForPath(rel) !== undefined || REGEX_TIER.test(rel);
}

function capped<T>(list: T[], cap: number): { list: T[]; cut: boolean } {
  return list.length > cap ? { list: list.slice(0, cap), cut: true } : { list, cut: false };
}

/** Builds the map of the tree at `dir` (a scan snapshot). Never throws for one file. */
export async function buildCodeIndex(dir: string): Promise<CodeIndex> {
  const started = Date.now();
  const reader = new SnapshotReader(dir);
  const all = await reader.list();
  let truncated = reader.truncated;
  let candidates = all.filter(isIndexable);
  if (candidates.length > CODE_INDEX_CAPS.files) {
    candidates = candidates.slice(0, CODE_INDEX_CAPS.files);
    truncated = true;
  }

  const files: CodeIndexFile[] = [];
  const defs: CodeIndexDef[] = [];
  const rawRefs = new Map<string, { path: string; symbol: string; lines: Set<number> }>();
  const rawCalls: CodeIndexCall[] = [];
  const imports: CodeIndexImport[] = [];

  for (const rel of candidates) {
    const text = await reader.read(rel);
    if (text === null) continue; // large, binary, symlink: the reader's rules
    let graph;
    try {
      graph = await extractGraph(text, rel);
    } catch {
      continue; // Lodestone never throws by contract; this is belt and braces
    }
    files.push({
      path: rel,
      contentHash: createHash('sha256').update(text).digest('hex'),
      language:
        languageForPath(rel) ?? (REGEX_TIER.test(rel) ? rel.split('.').pop()!.toLowerCase() : null),
      method: graph.method,
      lineCount: text.length === 0 ? 0 : text.split('\n').length,
    });
    for (const d of graph.defs) {
      defs.push({
        path: rel,
        symbol: d.symbol,
        kind: d.kind,
        startLine: d.startLine,
        endLine: d.endLine,
      });
    }
    for (const r of graph.refs) {
      const key = `${rel}\u0000${r.symbol}`;
      let row = rawRefs.get(key);
      if (!row) rawRefs.set(key, (row = { path: rel, symbol: r.symbol, lines: new Set() }));
      row.lines.add(r.line);
    }
    for (const c of graph.calls)
      rawCalls.push({ path: rel, caller: c.caller, callee: c.callee, line: c.line });
    for (const i of graph.imports)
      imports.push({ path: rel, target: i.toPathOrModule, line: i.line });
  }

  // Keep references and calls to names the repository defines: "who uses X"
  // for a library function or a local variable is not a question the map is for.
  const defined = new Set(defs.map((d) => d.symbol));
  const refs: CodeIndexRef[] = [];
  for (const r of rawRefs.values()) {
    if (defined.has(r.symbol))
      refs.push({ path: r.path, symbol: r.symbol, lines: [...r.lines].sort((a, b) => a - b) });
  }
  const calls = rawCalls.filter((c) => defined.has(c.callee));

  const d = capped(defs, CODE_INDEX_CAPS.defs);
  const r = capped(refs, CODE_INDEX_CAPS.refs);
  const c = capped(calls, CODE_INDEX_CAPS.calls);
  const i = capped(imports, CODE_INDEX_CAPS.imports);
  return {
    extractor: CODE_INDEX_EXTRACTOR,
    files,
    defs: d.list,
    refs: r.list,
    calls: c.list,
    imports: i.list,
    truncated: truncated || d.cut || r.cut || c.cut || i.cut,
    buildMs: Date.now() - started,
  };
}
