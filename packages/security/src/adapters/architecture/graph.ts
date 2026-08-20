import type { ArchitecturePack } from './pack.js';

// Import-graph detections (W10-03, FR-REG-5).
//
// PURE, and shared by every language adapter: a cycle is a cycle whether the
// graph came from dependency-cruiser or grimp, and a second implementation per
// language would be three chances to define "god module" differently.
//
// CONFIG-FREE means every rule here is answerable from the graph's own shape.
// Nothing reads a boundary contract, because a boundary is a statement of
// intent and this register has none to read (phase B, deliberately absent).

export interface ImportGraph {
  /** module id -> the modules it imports. Ids are language-native. */
  edges: Map<string, string[]>;
  /** module id -> the repo-relative file, for the finding's location. */
  files: Map<string, string>;
}

export interface ArchitectureFinding {
  ruleId: string;
  severity: number;
  /** Repo-relative file the finding points at, or null for repo-level. */
  file: string | null;
  title: string;
  evidence: string;
  recommendation: string;
  /** Every module involved, for the evidence and for dedup distinctness. */
  members: string[];
}

export interface DetectionResult {
  findings: ArchitectureFinding[];
  /**
   * Detections that could NOT be run and why.
   *
   * A repo with eleven modules has no distribution to be an outlier against.
   * Saying so is the difference between "no god modules" and "we could not
   * look" — the null-vs-zero conflation this codebase keeps having to undo.
   */
  notRun: { ruleId: string; reason: string }[];
  moduleCount: number;
}

/** Strongly connected components, Tarjan. Components of size 1 are not cycles. */
export function stronglyConnected(edges: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  // Iterative rather than recursive: a monorepo import graph is deep enough to
  // blow the stack, and a scanner that crashes on big repos is a scanner for
  // small ones.
  const nodes = [...edges.keys()].sort();
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const children = edges.get(frame.node) ?? [];
      if (frame.next < children.length) {
        const child = children[frame.next]!;
        frame.next += 1;
        if (!edges.has(child)) continue;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const node = stack.pop()!;
          onStack.delete(node);
          component.push(node);
          if (node === frame.node) break;
        }
        if (component.length > 1) components.push(component.sort());
      }
    }
  }

  // A self-import is a cycle of one and Tarjan will not report it.
  for (const [node, targets] of edges) {
    if (targets.includes(node)) components.push([node]);
  }

  return components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

/** Weakly connected components — direction ignored, for orphan clusters. */
export function weaklyConnected(edges: Map<string, string[]>): string[][] {
  const neighbours = new Map<string, Set<string>>();
  for (const node of edges.keys()) neighbours.set(node, new Set());
  for (const [node, targets] of edges) {
    for (const target of targets) {
      if (!edges.has(target)) continue;
      neighbours.get(node)!.add(target);
      neighbours.get(target)!.add(node);
    }
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const node of [...edges.keys()].sort()) {
    if (seen.has(node)) continue;
    const component: string[] = [];
    const queue = [node];
    seen.add(node);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of neighbours.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    components.push(component.sort());
  }
  return components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[rank]!;
}

const shortList = (members: string[], limit = 6): string =>
  members.length <= limit
    ? members.join(' → ')
    : `${members.slice(0, limit).join(' → ')} … (+${members.length - limit} more)`;

export function detectArchitecture(graph: ImportGraph, pack: ArchitecturePack): DetectionResult {
  const findings: ArchitectureFinding[] = [];
  const notRun: DetectionResult['notRun'] = [];
  const moduleCount = graph.edges.size;
  const fileOf = (module: string): string | null => graph.files.get(module) ?? null;

  // --- cycles ---------------------------------------------------------------
  for (const component of stronglyConnected(graph.edges)) {
    const escalated = component.length >= pack.cycle.escalateAtSize;
    findings.push({
      ruleId: pack.cycle.id,
      severity: escalated ? pack.cycle.escalatedSeverity : pack.cycle.severity,
      file: fileOf(component[0]!),
      title:
        component.length === 1
          ? `Module imports itself: ${component[0]}`
          : `Import cycle across ${component.length} modules`,
      // Every member is named: two cycles that share a module must not produce
      // the same evidence string, or they collide on the findings dedup key.
      evidence: shortList(component),
      recommendation:
        'Break the cycle by moving the shared code into a module both sides may import, or by inverting one dependency.',
      members: component,
    });
  }

  // --- god modules ----------------------------------------------------------
  if (moduleCount < pack.godModule.minModules) {
    notRun.push({
      ruleId: pack.godModule.id,
      reason: `${moduleCount} modules is below the ${pack.godModule.minModules} needed for a distribution to be an outlier against`,
    });
  } else {
    const fanOut = new Map<string, number>();
    const fanIn = new Map<string, number>();
    for (const node of graph.edges.keys()) {
      fanOut.set(node, 0);
      fanIn.set(node, 0);
    }
    for (const [node, targets] of graph.edges) {
      const internal = targets.filter((t) => graph.edges.has(t));
      fanOut.set(node, internal.length);
      for (const target of internal) fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
    }

    const degrees = [...graph.edges.keys()].map(
      (node) => (fanIn.get(node) ?? 0) + (fanOut.get(node) ?? 0),
    );
    const threshold = percentile(degrees, pack.godModule.percentile) * pack.godModule.multiple;

    for (const node of [...graph.edges.keys()].sort()) {
      const degree = (fanIn.get(node) ?? 0) + (fanOut.get(node) ?? 0);
      // BOTH gates: a repo whose 90th percentile is 1 would otherwise make a
      // module with three imports a "god module".
      if (degree < pack.godModule.minDegree || degree <= threshold) continue;
      findings.push({
        ruleId: pack.godModule.id,
        severity: pack.godModule.severity,
        file: fileOf(node),
        title: `Everything goes through ${node}`,
        evidence: `${node}: ${fanIn.get(node)} modules import it and it imports ${fanOut.get(node)} — a combined ${degree} against a repo 90th percentile of ${percentile(degrees, pack.godModule.percentile)}.`,
        recommendation:
          'Split the module along the seams its dependents actually use; a module every change touches is a module every change can break.',
        members: [node],
      });
    }
  }

  // --- orphan clusters ------------------------------------------------------
  const components = weaklyConnected(graph.edges);
  const main = components[0];
  const second = components[1];
  // "Orphan" only means anything against a MAIN BODY. Two clusters of equal
  // size are two applications in one repository, and picking one of them to
  // call the orphan would be an arbitrary label on a coin flip.
  const ambiguous =
    main !== undefined && second !== undefined && main.length === second.length;
  if (ambiguous) {
    notRun.push({
      ruleId: pack.orphan.id,
      reason: `the two largest module clusters are the same size (${main!.length}), so there is no main body to be orphaned from`,
    });
  }
  for (const component of ambiguous ? [] : components.slice(1)) {
    if (component.length < pack.orphan.minClusterSize) continue;
    findings.push({
      ruleId: pack.orphan.id,
      severity: pack.orphan.severity,
      file: fileOf(component[0]!),
      title: `${component.length} modules with no connection to the rest of the tree`,
      evidence: `${shortList(component)} — this cluster imports only itself, and nothing in the ${main?.length ?? 0}-module main body imports it.`,
      recommendation:
        'Confirm this is still reachable from an entrypoint. A cluster nobody imports is either dead code or an undocumented second application.',
      members: component,
    });
  }

  return { findings, notRun, moduleCount };
}
