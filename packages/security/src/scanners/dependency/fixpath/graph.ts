// Dependency graphs read from lockfiles (W18-36). Pure.
//
// A node is one resolved package version. Roots are the packages the project
// itself asks for; everything else is reached through them. The graph is built
// only from the lockfile text in the snapshot, so a fix path is a statement
// about what is installed — never a guess about what a registry might offer.

export type FixEcosystem = 'npm' | 'pypi' | 'go' | 'cargo';

export interface GraphNode {
  name: string;
  version: string;
  /** Node ids this package depends on. */
  deps: string[];
}

export interface DepGraph {
  ecosystem: FixEcosystem;
  /** Snapshot-relative lockfile this graph came from. */
  manifest: string;
  /** Which package manager wrote it: npm, pnpm, yarn, poetry, uv, cargo, gomod. */
  manager: string;
  nodes: Map<string, GraphNode>;
  /** Node ids the project depends on directly. */
  roots: string[];
  /**
   * False when the lockfile carries no edges (go.mod, requirements.txt), so a
   * package that is not a root cannot be traced to the dependency that pulls it.
   */
  hasEdges: boolean;
}

export const nodeId = (name: string, version: string): string => `${name}@${version}`;

export function normalizeName(ecosystem: FixEcosystem, name: string): string {
  const lower = name.toLowerCase();
  return ecosystem === 'pypi' ? lower.replace(/[-_.]+/g, '-') : lower;
}

export function addNode(graph: DepGraph, name: string, version: string): GraphNode {
  const id = nodeId(name, version);
  let node = graph.nodes.get(id);
  if (!node) {
    node = { name, version, deps: [] };
    graph.nodes.set(id, node);
  }
  return node;
}

export function newGraph(
  ecosystem: FixEcosystem,
  manifest: string,
  manager: string,
  hasEdges = true,
): DepGraph {
  return { ecosystem, manifest, manager, nodes: new Map(), roots: [], hasEdges };
}

export interface FixPath {
  /** Root first, vulnerable package last. */
  chain: GraphNode[];
  /** Other shortest-or-longer routes to the same package, not listed. */
  otherPaths: number;
}

/**
 * The shortest chain from a root to any node named `name` at `version`
 * (or at any version when that exact one is not present).
 */
export function findPath(graph: DepGraph, name: string, version: string): FixPath | null {
  const want = normalizeName(graph.ecosystem, name);
  const matches = (id: string): boolean => {
    const node = graph.nodes.get(id);
    return !!node && normalizeName(graph.ecosystem, node.name) === want && node.version === version;
  };
  const targets = [...graph.nodes.keys()].filter(matches);
  if (targets.length === 0) return null;
  const targetSet = new Set(targets);

  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const root of graph.roots) {
    if (!graph.nodes.has(root) || parent.has(root)) continue;
    parent.set(root, null);
    queue.push(root);
  }
  let found: string | null = null;
  let reaching = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (targetSet.has(id)) {
      found ??= id;
      reaching += 1;
      continue;
    }
    for (const dep of graph.nodes.get(id)?.deps ?? []) {
      if (parent.has(dep) || !graph.nodes.has(dep)) continue;
      parent.set(dep, id);
      queue.push(dep);
    }
  }
  if (found === null) return null;
  const chain: GraphNode[] = [];
  for (let at: string | null = found; at !== null; at = parent.get(at) ?? null) {
    chain.unshift(graph.nodes.get(at)!);
  }
  return { chain, otherPaths: Math.max(0, reaching - 1) };
}
