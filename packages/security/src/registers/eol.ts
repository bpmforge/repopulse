// Runtime / toolchain EOL register (W10-02, FR-REG-3).
//
// Reads the SNAPSHOT's declared runtimes — engines fields, .nvmrc,
// python_requires, Dockerfile base images — against the eol_products rows the
// nightly sync wrote. The snapshot is the C1a tarball extraction; nothing here
// clones and nothing here calls the network.
//
// UNKNOWN PRODUCES NOTHING. If a product is not in eol_products, or a declared
// version matches no cycle, this register is silent. "We have no data" and
// "you are fine" must never render the same way, and a guessed EOL date is a
// deadline someone would plan around.

export interface EolCycleRow {
  product: string;
  cycle: string;
  eolDate: Date | null;
  supportUntil: Date | null;
  latestVersion: string | null;
}

export interface DeclaredRuntime {
  product: string;
  /** Version or cycle as declared: '20', '3.11', 'bookworm'. */
  version: string;
  /** Where it was declared, for the finding's location. */
  file: string;
  /** Build-only toolchain (a builder stage, a dev container) ranks lower. */
  dev?: boolean;
}

export interface EolFinding {
  product: string;
  cycle: string;
  severity: number;
  file: string;
  title: string;
  evidence: string;
  recommendation: string;
  ruleId: string;
  daysToEol: number | null;
}

/** Products endoflife.date names differently from the ecosystem that uses them. */
const PRODUCT_ALIASES: Record<string, string> = {
  node: 'nodejs',
  'node-alpine': 'nodejs',
  py: 'python',
  golang: 'go',
};

export const EOL_HORIZON_DAYS = 90;

export function normalizeProduct(name: string): string {
  const lower = name.toLowerCase();
  return PRODUCT_ALIASES[lower] ?? lower;
}

/**
 * Which cycle a declared version belongs to.
 *
 * Longest matching prefix on dotted segments: '3.11.4' matches cycle '3.11'
 * before it matches '3'. A plain `startsWith` would match '3.1' to '3.11' and
 * report the EOL date of a release the repo is not running.
 */
export function cycleFor(version: string, cycles: readonly EolCycleRow[]): EolCycleRow | null {
  const declared = version.trim().replace(/^[v^~>=<\s]+/, '');
  if (declared === '') return null;
  const segments = declared.split('.');

  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length).join('.');
    const match = cycles.find((cycle) => cycle.cycle === candidate);
    if (match) return match;
  }
  // Codename cycles ('bookworm', 'jammy') are not dotted at all.
  return cycles.find((cycle) => cycle.cycle.toLowerCase() === declared.toLowerCase()) ?? null;
}

export interface EolInput {
  declared: readonly DeclaredRuntime[];
  cycles: readonly EolCycleRow[];
  now: Date;
  horizonDays?: number;
}

export interface EolResult {
  findings: EolFinding[];
  /** Declarations with no matching product or cycle — no finding, but counted. */
  unknown: { product: string; version: string; reason: 'no_product' | 'no_cycle' }[];
}

export function eolFindings(input: EolInput): EolResult {
  const horizon = input.horizonDays ?? EOL_HORIZON_DAYS;
  const findings: EolFinding[] = [];
  const unknown: EolResult['unknown'] = [];

  for (const runtime of input.declared) {
    const product = normalizeProduct(runtime.product);
    const cycles = input.cycles.filter((row) => row.product === product);
    if (cycles.length === 0) {
      unknown.push({ product, version: runtime.version, reason: 'no_product' });
      continue;
    }

    const cycle = cycleFor(runtime.version, cycles);
    if (!cycle || !cycle.eolDate) {
      unknown.push({ product, version: runtime.version, reason: 'no_cycle' });
      continue;
    }

    const days = Math.floor((cycle.eolDate.getTime() - input.now.getTime()) / 86_400_000);
    if (days > horizon) continue;

    const past = days < 0;
    const severity = past ? (runtime.dev ? 3 : 4) : runtime.dev ? 1 : 2;
    findings.push({
      product,
      cycle: cycle.cycle,
      severity,
      file: runtime.file,
      daysToEol: days,
      title: past
        ? `${product} ${cycle.cycle} is past end-of-life`
        : `${product} ${cycle.cycle} reaches end-of-life in ${days} days`,
      evidence: `${runtime.file} declares ${runtime.product} ${runtime.version}; cycle ${cycle.cycle} EOL ${cycle.eolDate.toISOString().slice(0, 10)}.`,
      recommendation: past
        ? `Move to a supported ${product} cycle — an EOL runtime stops receiving security fixes entirely.`
        : `Plan the ${product} upgrade before ${cycle.eolDate.toISOString().slice(0, 10)}.`,
      ruleId: past ? 'eol.past' : 'eol.approaching',
    });
  }

  return { findings, unknown };
}

// --- reading declarations out of a snapshot ---------------------------------

const DOCKER_FROM = /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s:]+):([^\s@]+)/gim;

/** Base images out of a Dockerfile. Stages named with AS are still images. */
export function dockerfileRuntimes(file: string, contents: string): DeclaredRuntime[] {
  const out: DeclaredRuntime[] = [];
  for (const match of contents.matchAll(DOCKER_FROM)) {
    const image = match[1]!;
    const tag = match[2]!;
    if (tag === 'latest') continue;
    // 'library/node', 'docker.io/node' — the product is the last path segment.
    const product = image.split('/').pop() ?? image;
    // '20-alpine' declares node 20 on alpine; the node cycle is what matters.
    const version = tag.split('-')[0]!;
    if (!/^\d/.test(version) && !/^[a-z]+$/.test(version)) continue;
    out.push({ product, version, file });
  }
  return out;
}

/** engines.node / .nvmrc / pyproject requires-python — the declared runtimes. */
export function manifestRuntimes(file: string, contents: string): DeclaredRuntime[] {
  if (file.endsWith('.nvmrc')) {
    const version = contents.trim();
    return version === '' ? [] : [{ product: 'nodejs', version, file }];
  }

  if (file.endsWith('package.json')) {
    try {
      const engines = (JSON.parse(contents) as { engines?: Record<string, string> }).engines ?? {};
      return Object.entries(engines).flatMap(([name, range]) =>
        typeof range === 'string' ? [{ product: name, version: range, file }] : [],
      );
    } catch {
      // A package.json we cannot parse is not an EOL fact; say nothing.
      return [];
    }
  }

  if (file.endsWith('pyproject.toml')) {
    const match = /requires-python\s*=\s*["']([^"']+)["']/.exec(contents);
    return match ? [{ product: 'python', version: match[1]!, file }] : [];
  }

  return [];
}
