import { findPath, normalizeName, type DepGraph, type FixEcosystem } from './graph.js';

// Fix advice for a vulnerable package (W18-36). Pure; advice only (D9a — RepoPulse
// never writes to a repository, so this is text a person acts on).
//
// WHAT A LOCKFILE CAN AND CANNOT SAY. It records what is installed and which
// package pulled it in, so the route from a direct dependency to the vulnerable
// package is exact. It does not record what a newer release of that direct
// dependency would depend on — that lives in a registry, which the scan sandbox
// cannot reach. So for a transitive package this names the dependency to bump
// and gives a pin that is correct by construction, and says plainly that the
// release of the direct dependency that picks up the fix has to be looked up.

export interface FixInput {
  /** grype's artifact type: npm, python, go-module, rust-crate. */
  packageType: string;
  name: string;
  version: string;
  fixVersions: readonly string[];
}

export type FixKind = 'direct' | 'transitive' | 'go_get' | 'no_fix' | 'unreadable';

export interface FixAdvice {
  kind: FixKind;
  text: string;
  /** `a@1 → b@2 → name@3`, root first, when a route was found. */
  chain: string[];
}

export function fixEcosystemOf(packageType: string): FixEcosystem | null {
  if (packageType === 'npm') return 'npm';
  if (packageType === 'python') return 'pypi';
  if (packageType === 'go-module') return 'go';
  if (packageType === 'rust-crate') return 'cargo';
  return null;
}

function numbers(version: string): number[] {
  return version
    .replace(/^[^\d]*/, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => !Number.isNaN(n));
}

/** The lowest listed fix: the smallest upgrade that clears it. */
export function lowestFix(fixVersions: readonly string[]): string | null {
  const sorted = [...fixVersions].sort((a, b) => {
    const x = numbers(a);
    const y = numbers(b);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return sorted[0] ?? null;
}

const PIN: Record<string, (name: string, fix: string) => string> = {
  npm: (n, f) => `add "${n}": "${f}" under "overrides" in package.json`,
  pnpm: (n, f) => `add "${n}": "${f}" under "pnpm.overrides" in package.json`,
  yarn: (n, f) => `add "${n}": "${f}" under "resolutions" in package.json`,
  poetry: (n, f) => `add ${n} = ">=${f}" as a direct dependency in pyproject.toml`,
  uv: (n, f) => `add "${n}>=${f}" to override-dependencies in pyproject.toml`,
  cargo: (n, f) => `run cargo update -p ${n} --precise ${f} (or raise the requirement in the crate that depends on it)`,
};

export function adviseFix(graphs: readonly DepGraph[], input: FixInput): FixAdvice | null {
  const ecosystem = fixEcosystemOf(input.packageType);
  if (!ecosystem) return null;
  const fix = lowestFix(input.fixVersions);
  const label = `${input.name} ${input.version}`;

  const mine = graphs.filter((g) => g.ecosystem === ecosystem);
  let route: { graph: DepGraph; chain: string[]; otherPaths: number } | null = null;
  let present: DepGraph | null = null;
  for (const graph of mine) {
    const found = findPath(graph, input.name, input.version);
    if (found) {
      route = {
        graph,
        chain: found.chain.map((n) => `${n.name}@${n.version}`),
        otherPaths: found.otherPaths,
      };
      break;
    }
    const want = normalizeName(ecosystem, input.name);
    if (
      !present &&
      [...graph.nodes.values()].some(
        (n) => normalizeName(ecosystem, n.name) === want && n.version === input.version,
      )
    ) {
      present = graph;
    }
  }

  if (fix === null) {
    return {
      kind: 'no_fix',
      text:
        `No fixed version of ${input.name} is published, so no upgrade clears this` +
        `${route && route.chain.length > 1 ? ` (it is pulled in through ${route.chain[0]})` : ''}: ` +
        'the options are a workaround, replacing the package, or removing it.',
      chain: route?.chain ?? [],
    };
  }

  if (ecosystem === 'go') {
    const direct = present ?? route?.graph;
    const isRoot = route !== null;
    return {
      kind: 'go_get',
      text:
        `Run go get ${input.name}@v${fix.replace(/^v/, '')} — Go lets you raise ` +
        `${isRoot ? 'a direct' : direct ? 'an indirect' : 'a'} requirement in place, so no other module has to change first.`,
      chain: route?.chain ?? [],
    };
  }

  if (route && route.chain.length === 1) {
    return {
      kind: 'direct',
      text: `Upgrade ${input.name} from ${input.version} to ${fix}; it is a direct dependency, so this is the whole change.`,
      chain: route.chain,
    };
  }

  if (route) {
    const first = route.chain[0]!;
    const manager = route.graph.manager;
    const pin = PIN[manager]?.(input.name, fix);
    const others = route.otherPaths > 0 ? ` (and ${route.otherPaths} other route${route.otherPaths === 1 ? '' : 's'})` : '';
    return {
      kind: 'transitive',
      text:
        `${label} is reached through ${route.chain.join(' → ')}${others}. The real fix is to upgrade the ` +
        `direct dependency ${first} to a release that depends on ${input.name} ${fix} or later; a lockfile ` +
        `records only what is installed, so which release of ${first.split('@')[0]} that is must be read from its ` +
        `changelog or the registry.${pin ? ` To clear it now without waiting, ${pin}.` : ''}`,
      chain: route.chain,
    };
  }

  return {
    kind: 'unreadable',
    text:
      `Upgrade ${input.name} to ${fix}. RepoPulse could not trace ${label} through a lockfile graph here` +
      `${mine.length === 0 ? ' (no readable lockfile for this ecosystem)' : ''}, so it cannot say which dependency pulls it in.`,
    chain: [],
  };
}
