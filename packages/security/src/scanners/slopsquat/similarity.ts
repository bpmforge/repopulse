import { normalizePackageName, type SlopEcosystem } from './names.js';
import type { PopularList } from './popular.js';

// Near-miss detection: is this name shaped like a typo of a popular one? (W21-05)
//
// The patterns are the ones typosquatting campaigns have actually used, named
// so the finding can say WHICH one it saw:
//
//   homoglyph  a look-alike glyph: `jeIlyfish` (capital I for l, PyPI 2019),
//              `0` for `o`, `rn` for `m`
//   separator  the same letters with a separator added, dropped or swapped:
//              `crossenv` for `cross-env` (npm 2017), `atlas-client` for
//              `atlas_client` (RubyGems 2020), `rustdecimal` for
//              `rust_decimal` (crates.io 2022)
//   affix      ecosystem noise around a real name: `python3-dateutil` for
//              `python-dateutil` (PyPI 2019), `-js`, `node-`, `py`
//   owner      Go: a real repository under a look-alike owner:
//              `github.com/boltdb-go/bolt` for `github.com/boltdb/bolt` (2025)
//   edit       ONE edit — omission, insertion, substitution or an adjacent
//              swap (optimal string alignment) — of a top-1,000 name, on
//              names of five characters or more, keeping the first letter.
//
// MEASURED, not guessed: over the 2,000 real npm and the 2,000 real PyPI
// packages ranked just below the shipped lists (ranks 5,001-7,000), a first
// cut with two edits, any target rank and no family rule flagged 44 and 72 of
// them; the rules here flag 8 and 14 (0.40% and 0.70%), each a severity-3,
// confidence-2 near-miss in shadow. No incident in the fixture corpus needed
// what was cut.
//
// WHAT IS NEVER A NEAR MISS: a name that is itself on the popular list (both
// `request` and `requests` are real); names that differ only in a trailing
// version (`vue2`/`vue3`, a Go module's `/v2` and `/v5`); and members of one
// family (same npm scope, or the same name up to a short last segment —
// `@aws-sdk/client-ses`/`client-sts`, `mypy-boto3-emr`/`-ecr`).

export type NearMissPattern = 'homoglyph' | 'separator' | 'affix' | 'owner' | 'edit';

export interface NearMiss {
  /** The popular package this one imitates, normalised. */
  target: string;
  pattern: NearMissPattern;
  /** Edit distance between the normalised names. */
  distance: number;
  /** The target's rank in its popular list, 0-based. */
  rank: number;
}

const STRENGTH: Record<NearMissPattern, number> = {
  homoglyph: 0,
  separator: 1,
  affix: 2,
  owner: 3,
  edit: 4,
};

/** Optimal string alignment distance, giving up above `cap`. */
export function osaDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[n]!;
}

const stripSeparators = (s: string): string => s.replace(/[-_.]/g, '');
/** A trailing version number: `vue2`, `vue3`, `-v5`. */
const stripTrailingVersion = (s: string): string => s.replace(/[-_.]?v?\d+$/, '');

/** Plain one-edit misspellings only count against the very top of a registry. */
export const EDIT_TARGET_COUNT = 1000;

/**
 * Members of one family, not typos of each other: same scope (only the
 * scope's owner can publish into it, so a squat cannot live there), or the
 * same name up to a final segment of three characters or fewer — a service
 * or method code (`@aws-sdk/client-ses`/`-sts`,
 * `mypy-boto3-emr`/`-ecr`, `lodash.get`/`.set`).
 */
function sameFamily(name: string, target: string): boolean {
  if (name.startsWith('@') && target.startsWith('@') && name.split('/')[0] === target.split('/')[0])
    return true;
  const a = name.split(/[-./]/);
  const b = target.split(/[-./]/);
  if (a.length < 2 || a.length !== b.length) return false;
  const lastA = a[a.length - 1]!;
  const lastB = b[b.length - 1]!;
  return (
    a.slice(0, -1).join('-') === b.slice(0, -1).join('-') &&
    Math.max(lastA.length, lastB.length) <= 3
  );
}

/** Look-alike glyphs folded, on the name AS WRITTEN (case matters for I/l). */
function deglyph(raw: string): string {
  return raw
    .replace(/I/g, 'l')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
}

const AFFIXES: Record<SlopEcosystem, { prefixes: string[]; suffixes: string[] }> = {
  npm: {
    prefixes: ['node-', 'js-', 'npm-'],
    suffixes: ['-js', '.js', 'js', '-node', '-npm', '-lib'],
  },
  pypi: {
    prefixes: ['python-', 'python3-', 'py-', 'py', 'pip-'],
    suffixes: ['-python', '-py', 'py', '-python3', '-lib'],
  },
  cargo: { prefixes: ['rust-', 'rs-'], suffixes: ['-rs', '-rust', 'rs'] },
  rubygems: { prefixes: ['ruby-', 'rb-'], suffixes: ['-ruby', '-rb', 'rb'] },
  go: { prefixes: [], suffixes: [] },
  maven: { prefixes: [], suffixes: [] },
};

/** `name` minus one known prefix or suffix, or null. */
function stems(ecosystem: SlopEcosystem, name: string): string[] {
  const out: string[] = [];
  const { prefixes, suffixes } = AFFIXES[ecosystem];
  for (const p of prefixes)
    if (name.startsWith(p) && name.length > p.length + 2) out.push(name.slice(p.length));
  for (const s of suffixes)
    if (name.endsWith(s) && name.length > s.length + 2) out.push(name.slice(0, -s.length));
  return out;
}

/**
 * One edit, on names long enough that one edit is not a different word, and
 * not at the first character: typosquats keep the start a person types
 * (`colourama`, `loadsh`, `electorn`), while real neighbours that differ there
 * are other words (`echarts`/`recharts`, `verror`/`error`, `bpython`/`ipython`).
 */
function editAllowed(a: string, b: string, distance: number): boolean {
  return distance === 1 && Math.min(a.length, b.length) >= 5 && a[0] === b[0];
}

/** One candidate pair, classified, or null when it is not a near miss. */
function classify(
  ecosystem: SlopEcosystem,
  raw: string,
  name: string,
  target: string,
  rank: number,
): { pattern: NearMissPattern; distance: number } | null {
  if (name === target) return null;
  // Versioned siblings are a convention, not a typo.
  if (stripTrailingVersion(name) === stripTrailingVersion(target)) return null;
  if (ecosystem !== 'go' && ecosystem !== 'maven' && sameFamily(name, target)) return null;
  const distance = osaDistance(name, target, 3);

  if (deglyph(raw) === deglyph(target) && raw.toLowerCase() !== target) {
    return { pattern: 'homoglyph', distance };
  }
  if (
    ecosystem !== 'go' &&
    ecosystem !== 'maven' &&
    stripSeparators(name) === stripSeparators(target)
  ) {
    return { pattern: 'separator', distance };
  }
  // Noise ADDED to a real name. Not the reverse: `fetch` is not a typo of
  // `node-fetch`, it is a different, shorter name.
  const nameStems = stems(ecosystem, name);
  if (nameStems.includes(target) || nameStems.some((s) => stems(ecosystem, target).includes(s))) {
    return { pattern: 'affix', distance };
  }
  if (ecosystem === 'go') return goOwner(name, target, distance);
  if (ecosystem === 'maven') {
    return distance <= 2 && Math.min(name.length, target.length) >= 12
      ? { pattern: 'edit', distance }
      : null;
  }
  return rank < EDIT_TARGET_COUNT && editAllowed(name, target, distance)
    ? { pattern: 'edit', distance }
    : null;
}

/** Go: same host and repository path, look-alike owner — or a close full path. */
function goOwner(
  name: string,
  target: string,
  distance: number,
): { pattern: NearMissPattern; distance: number } | null {
  const strip = (p: string): string => p.replace(/\/v\d+$/, '');
  const a = strip(name).split('/');
  const b = strip(target).split('/');
  if (strip(name) === strip(target)) return null;
  if (
    a.length >= 3 &&
    a.length === b.length &&
    a[0] === b[0] &&
    a.slice(2).join('/') === b.slice(2).join('/')
  ) {
    const owner = a[1]!.toLowerCase();
    const real = b[1]!.toLowerCase();
    const ownerDistance = osaDistance(owner, real, 3);
    const contains = owner.includes(real) || real.includes(owner);
    if (
      owner !== real &&
      (ownerDistance <= 1 || (contains && Math.min(owner.length, real.length) >= 4))
    ) {
      return { pattern: 'owner', distance };
    }
  }
  return distance <= 2 && Math.min(name.length, target.length) >= 15
    ? { pattern: 'edit', distance }
    : null;
}

/** The closest popular package this name imitates, or null. */
export function nearMiss(
  ecosystem: SlopEcosystem,
  raw: string,
  popular: PopularList,
): NearMiss | null {
  const name = normalizePackageName(ecosystem, raw);
  if (popular.rank.has(name)) return null;
  let best: NearMiss | null = null;
  for (const target of popular.targets) {
    const rank = popular.rank.get(target) ?? 0;
    const hit = classify(ecosystem, raw, name, target, rank);
    if (!hit) continue;
    const candidate: NearMiss = { target, ...hit, rank };
    if (
      best === null ||
      STRENGTH[candidate.pattern] < STRENGTH[best.pattern] ||
      (STRENGTH[candidate.pattern] === STRENGTH[best.pattern] &&
        (candidate.distance < best.distance ||
          (candidate.distance === best.distance && candidate.rank < best.rank)))
    ) {
      best = candidate;
    }
  }
  return best;
}
