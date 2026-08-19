import { createHash } from 'node:crypto';

// Attack chain construction (W8-09, SECURITY_SUITE.md §3.5, FR-SEC-8).
//
// A chain is the argument that three medium findings are one serious problem:
// this credential opens that database, which contains the token for that admin
// endpoint. The product's whole claim here is that it can state such a path in
// terms a reader can check, so every step must reference the finding it came
// from — an unfalsifiable chain is a scary picture, not a finding.
//
// The matching is DELIBERATELY LITERAL: one finding's `yields` term must equal
// another's `preconditions` term. No inference, no synonyms, no model. A
// chainer that guesses produces plausible paths nobody can refute, which is
// worse than no chainer at all.

/** The shared vocabulary (§3.4/§3.5). Terms outside it never match. */
export const CHAIN_VOCABULARY = [
  'network-access',
  'authenticated',
  'admin',
  'rce',
  'sql-injection',
  'ssrf',
  'auth-bypass',
  'data-read',
  'data-write',
  'predictable-token',
  'log-exposure',
  'supply-chain',
  'prompt-injection',
  'model-output-trusted',
] as const;

/** `credential:aws`, `vuln-dependency:CVE-…` — a namespaced term. */
const NAMESPACED = /^(credential|vuln-dependency|injection|authz-gap):[a-z0-9._:-]+$/i;

export function isVocabularyTerm(term: string): boolean {
  return (CHAIN_VOCABULARY as readonly string[]).includes(term) || NAMESPACED.test(term);
}

export interface ChainableFinding {
  id: number;
  dedupKey: string;
  severity: number;
  title: string;
  file: string | null;
  scannerKey: string | null;
  yields: string[];
  preconditions: string[];
}

export interface Chain {
  chainId: string;
  severity: number;
  /** Ordered entry → … → impact. */
  steps: ChainableFinding[];
  /** The term each hop matched on, one shorter than `steps`. */
  links: string[];
  summary: string;
}

/**
 * Severity of a chain: one worse than its worst link, capped at 5.
 *
 * Not the max, and definitely not the average. The point of a chain is that the
 * combination is worse than the parts — if a chain could never exceed its worst
 * member it would tell a reader nothing they did not already have.
 */
export function chainSeverity(members: readonly { severity: number }[]): number {
  const worst = members.reduce((max, m) => Math.max(max, m.severity), 0);
  return Math.min(5, worst + 1);
}

/**
 * A stable id for a chain: sha256 over its members' dedup keys, in order.
 *
 * Derived from the MEMBERS rather than generated, so recomputing chains over
 * unchanged findings produces the same id and the same dedup key — the chain
 * updates in place instead of arriving as a new finding every week.
 */
export function chainIdOf(steps: readonly ChainableFinding[]): string {
  const material = steps.map((s) => s.dedupKey).join('\0');
  return `chain-${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

function edges(findings: readonly ChainableFinding[]): Map<number, { to: number; term: string }[]> {
  const byPrecondition = new Map<string, ChainableFinding[]>();
  for (const finding of findings) {
    for (const term of finding.preconditions) {
      if (!isVocabularyTerm(term)) continue;
      const list = byPrecondition.get(term) ?? [];
      list.push(finding);
      byPrecondition.set(term, list);
    }
  }

  const out = new Map<number, { to: number; term: string }[]>();
  for (const finding of findings) {
    for (const term of finding.yields) {
      if (!isVocabularyTerm(term)) continue;
      for (const next of byPrecondition.get(term) ?? []) {
        // A finding cannot be its own next step, and two findings that yield
        // and require the same term in both directions would loop forever.
        if (next.id === finding.id) continue;
        const list = out.get(finding.id) ?? [];
        list.push({ to: next.id, term });
        out.set(finding.id, list);
      }
    }
  }
  return out;
}

export interface BuildOptions {
  /** Longest path to report. Depth is a readability limit, not a safety one. */
  maxDepth?: number;
  /** Cap on reported chains, newest-worst first. */
  maxChains?: number;
}

/**
 * Builds every maximal chain over a set of findings.
 *
 * Paths start at findings nothing else leads to (an ENTRY: something an
 * attacker can reach unaided) and extend while a `yields` term matches the next
 * finding's `preconditions`. A cycle stops at the repeated node rather than
 * being dropped — a loop still contains a real path up to that point.
 */
export function buildChains(
  findings: readonly ChainableFinding[],
  opts: BuildOptions = {},
): Chain[] {
  const maxDepth = opts.maxDepth ?? 6;
  const graph = edges(findings);
  const byId = new Map(findings.map((f) => [f.id, f]));

  const hasIncoming = new Set<number>();
  for (const list of graph.values()) for (const edge of list) hasIncoming.add(edge.to);

  // Entry points first; if every node has an incoming edge (a pure cycle),
  // fall back to all nodes so a real path is not lost to graph shape.
  const entries = findings.filter((f) => !hasIncoming.has(f.id));
  const roots = entries.length > 0 ? entries : findings;

  const chains: Chain[] = [];
  const seen = new Set<string>();

  const walk = (path: ChainableFinding[], links: string[]): void => {
    const next = graph.get(path[path.length - 1]!.id) ?? [];
    const onward = next.filter((edge) => !path.some((step) => step.id === edge.to));

    if (onward.length === 0 || path.length >= maxDepth) {
      if (path.length < 2) return; // a single finding is not a chain
      const chainId = chainIdOf(path);
      if (seen.has(chainId)) return;
      seen.add(chainId);
      chains.push({
        chainId,
        severity: chainSeverity(path),
        steps: [...path],
        links: [...links],
        summary: summaryOf(path, links),
      });
      return;
    }

    for (const edge of onward) {
      const step = byId.get(edge.to);
      if (!step) continue;
      walk([...path, step], [...links, edge.term]);
    }
  };

  for (const root of roots) walk([root], []);

  chains.sort((a, b) => b.severity - a.severity || a.chainId.localeCompare(b.chainId));
  return opts.maxChains ? chains.slice(0, opts.maxChains) : chains;
}

/** The path in one line — this is the chain finding's evidence. */
export function summaryOf(steps: readonly ChainableFinding[], links: readonly string[]): string {
  return steps
    .map((step, index) => (index === 0 ? step.title : `[${links[index - 1]}] → ${step.title}`))
    .join(' ');
}
