import { and, desc, eq } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// The repository's import graph, persisted (W18-25, RISK_MODEL.md §2).
//
// The fast lane builds it from a snapshot in the security scanner, but two
// consumers run long after that snapshot is deleted: the nightly reprice (the
// exposure factor) and the Tier-2 prompts (callers and callees as context).
// Neither may re-read the tree — C1 forbids a clone, and a second tarball per
// reprice would be a rate-limit cost for a number that changes weekly — so the
// graph is written down once, here, in the same series table every other
// snapshot metric uses.
//
// ONLY THE LATEST ROW IS KEPT. A graph is a property of one tree, nothing
// trends over it, and a weekly copy of a monorepo's edge list for the 400-day
// retention window would be megabytes of history nobody can read.

export const IMPORT_GRAPH_METRIC_KEY = 'import_graph';

export interface ImportGraphSnapshot {
  version: 1;
  commitSha: string;
  /**
   * The snapshot read hit no cap and skipped no file. When false, an importer
   * may simply not have been read, so neither "nothing imports this" nor a
   * fan-in count can be trusted, and exposure is left alone.
   */
  complete: boolean;
  /** File extensions the index understands. Anything else is unindexed. */
  extensions: string[];
  /** Every indexed file, repo-relative. Edges refer to these by position. */
  files: string[];
  /** [importer, imported, names taken — null for the whole module]. */
  edges: [number, number, string[] | null][];
  /**
   * Files an UNRESOLVED specifier may reach — a tsconfig path alias or a
   * workspace package name ending in the file's name. Such a file can have no
   * relative importer and still be imported everywhere.
   */
  aliased: number[];
}

export type ImportGraphState =
  'imported' | 'orphan' | 'entry' | 'aliased' | 'incomplete' | 'unindexed' | 'missing' | 'absent';

export interface ImportExposure {
  state: ImportGraphState;
  /** Distinct files importing this one; null where the graph cannot say. */
  fanIn: number | null;
}

/** A snapshot decoded for O(1) lookups per finding. */
export interface ImportGraphIndex {
  complete: boolean;
  extensions: string[];
  fanIn: Map<string, number>;
  aliased: Set<string>;
}

export function indexImportGraph(snapshot: ImportGraphSnapshot): ImportGraphIndex {
  const importers = new Map<string, Set<number>>();
  for (const [from, to] of snapshot.edges) {
    const target = snapshot.files[to];
    if (target === undefined || from === to) continue;
    const set = importers.get(target) ?? new Set<number>();
    set.add(from);
    importers.set(target, set);
  }
  const fanIn = new Map<string, number>();
  for (const file of snapshot.files) fanIn.set(file, importers.get(file)?.size ?? 0);
  return {
    complete: snapshot.complete,
    extensions: snapshot.extensions,
    fanIn,
    aliased: new Set(
      snapshot.aliased.map((i) => snapshot.files[i]).filter((f): f is string => !!f),
    ),
  };
}

/**
 * Files nothing is expected to import: entry points a runtime, a framework or a
 * tool loads by path. Without package.json in the graph these are recognised by
 * name, and erring towards "entry" costs a missed discount, never a wrong one.
 * Tests are NOT here: a finding in a test nothing imports really is less
 * exposed than the same finding in shipped code.
 */
const ENTRY_POINT = [
  /(^|\/)(index|main|mod|server|app|cli|worker|entry|bootstrap)\.[cm]?[jt]sx?$/,
  /\.d\.[cm]?ts$/,
  /(^|\/)[^/]*\.config\.[cm]?[jt]s$/,
  /(^|\/)(pages|app|routes|bin|cli|scripts?|migrations?|workers?|handlers?)\//,
  // Next.js-style API routes — not any directory named api, which in a
  // monorepo is a whole application.
  /(^|\/)(pages|app|src)\/api\//,
  /(^|\/)(middleware|instrumentation|run|migrate)\.[cm]?[jt]s$/,
  // Test-runner setup files and deploy tooling: loaded by a config or run by
  // node directly. On Repo Pulse's own tree (W18-25) the list leaves 3
  // non-test orphans: one genuinely unimported types file, and two demo
  // scripts only package.json names — which the snapshot does not carry.
  /\.setup\.[cm]?[jt]sx?$/,
  /(^|\/)(deploy|tools)\//,
];

export function looksLikeEntryPoint(file: string): boolean {
  return ENTRY_POINT.some((re) => re.test(file));
}

/** Where one file sits in the graph, or why the graph cannot say. */
export function importExposureFor(graph: ImportGraphIndex | null, file: string): ImportExposure {
  if (!graph) return { state: 'absent', fanIn: null };
  if (!graph.extensions.some((ext) => file.endsWith(ext))) {
    return { state: 'unindexed', fanIn: null };
  }
  // Checked before the per-file lookups: on a capped snapshot a zero is "we
  // did not read the importer", and a count is a lower bound of unknown size.
  if (!graph.complete) return { state: 'incomplete', fanIn: null };
  const fanIn = graph.fanIn.get(file);
  if (fanIn === undefined) return { state: 'missing', fanIn: null };
  if (fanIn > 0) return { state: 'imported', fanIn };
  if (graph.aliased.has(file)) return { state: 'aliased', fanIn: 0 };
  if (looksLikeEntryPoint(file)) return { state: 'entry', fanIn: 0 };
  return { state: 'orphan', fanIn: 0 };
}

/** The sentence the decomposition popover shows for the import-graph input. */
export function exposureWhy(exposure: ImportExposure): string {
  switch (exposure.state) {
    case 'imported': {
      const n = exposure.fanIn ?? 0;
      return `imported by ${n} module${n === 1 ? '' : 's'}`;
    }
    case 'orphan':
      return 'nothing imports this file';
    case 'entry':
      return 'nothing imports this file, but its path marks an entry point; exposure not adjusted';
    case 'aliased':
      return 'no relative import reaches this file, but an unresolved specifier may (a path alias); exposure not adjusted';
    case 'incomplete':
      return 'import graph incomplete (snapshot capped); exposure not adjusted';
    case 'unindexed':
      return 'no import index for this language; exposure not adjusted';
    case 'missing':
      return 'file not in the latest import graph; exposure not adjusted';
    case 'absent':
      return 'no import graph for this repository yet; exposure not adjusted';
  }
}

/** Replaces the repo's import graph with this one. */
export async function writeImportGraph(
  db: Database,
  params: { workspaceId: number; repoId: number; snapshot: ImportGraphSnapshot },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(read.metricSnapshots)
      .where(
        and(
          eq(read.metricSnapshots.workspaceId, params.workspaceId),
          eq(read.metricSnapshots.repoId, params.repoId),
          eq(read.metricSnapshots.metricKey, IMPORT_GRAPH_METRIC_KEY),
        ),
      );
    await tx.insert(read.metricSnapshots).values({
      workspaceId: params.workspaceId,
      repoId: params.repoId,
      metricKey: IMPORT_GRAPH_METRIC_KEY,
      // A tree at one commit, not a window of activity (the ch_* convention).
      window: 'all',
      value: String(params.snapshot.files.length),
      dims: params.snapshot as unknown as Record<string, unknown>,
    });
  });
}

/** The repo's latest import graph, or null when none was written or it is unreadable. */
export async function readImportGraph(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<ImportGraphSnapshot | null> {
  const [row] = await db
    .select({ dims: read.metricSnapshots.dims })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, workspaceId),
        eq(read.metricSnapshots.repoId, repoId),
        eq(read.metricSnapshots.metricKey, IMPORT_GRAPH_METRIC_KEY),
      ),
    )
    .orderBy(desc(read.metricSnapshots.computedAt))
    .limit(1);
  return row ? parseImportGraph(row.dims) : null;
}

/**
 * Validates a stored graph. A malformed row reads as NO graph — exposure goes
 * neutral — rather than as a graph in which every file is an orphan.
 */
export function parseImportGraph(raw: unknown): ImportGraphSnapshot | null {
  if (raw === null || typeof raw !== 'object') return null;
  const g = raw as Partial<Record<keyof ImportGraphSnapshot, unknown>>;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (g.version !== 1 || typeof g.complete !== 'boolean' || typeof g.commitSha !== 'string') {
    return null;
  }
  if (!strings(g.files) || !strings(g.extensions) || !Array.isArray(g.edges)) return null;
  if (!Array.isArray(g.aliased) || !g.aliased.every((i) => Number.isInteger(i))) return null;
  const n = g.files.length;
  const inRange = (i: unknown): i is number =>
    Number.isInteger(i) && (i as number) >= 0 && (i as number) < n;
  const edges: ImportGraphSnapshot['edges'] = [];
  for (const edge of g.edges) {
    if (!Array.isArray(edge) || !inRange(edge[0]) || !inRange(edge[1])) return null;
    const names = edge[2];
    if (names !== null && !strings(names)) return null;
    edges.push([edge[0], edge[1], names]);
  }
  return {
    version: 1,
    commitSha: g.commitSha,
    complete: g.complete,
    extensions: g.extensions,
    files: g.files,
    edges,
    aliased: g.aliased as number[],
  };
}
