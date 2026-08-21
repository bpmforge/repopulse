// Version ranges for VEX statements (W8-14, FR-SEC-14).
//
// A HAND-ROLLED COMPARATOR, and the reason is worth stating rather than
// leaving as an oddity: `semver` is not resolvable from this package, and more
// importantly a VEX statement is not always about an npm package. A statement
// can cover a PyPI or a Go module whose version strings semver rejects, and a
// comparator that threw on those would make the suppression path work for one
// ecosystem and fail closed for the rest.
//
// THE GRAMMAR IS DELIBERATELY NARROW, and narrow is the point. It is the set of
// things a human triaging a CVE actually writes down, and every form outside it
// is REFUSED AT WRITE TIME (`parseRange` returns an error the route turns into
// a 400) rather than silently misread later:
//
//   *                every version of this package
//   1.2.3            exactly this version
//   =1.2.3           the same thing, written explicitly
//   >=1.0.0 <2.0.0   space-separated comparators, ANDed
//
// There is no `||`, no `^`, no `~`. Caret and tilde mean different things in
// npm and in Python packaging, and a range whose meaning depends on which
// ecosystem the reader assumes is exactly the ambiguity a suppression record
// must not have.
//
// AND THE RULE FOR EVERYTHING ELSE: an unparseable version is NOT COVERED. A
// comparison we cannot make is not evidence that a suppression applies, so the
// finding stays open and the reason says which version defeated the parser. The
// failure mode of the other choice is a live vulnerability hidden by a typo.

export type Comparator = '=' | '<' | '<=' | '>' | '>=';

export interface RangeClause {
  op: Comparator;
  version: string;
}

export type ParsedRange = { ok: true; clauses: RangeClause[] } | { ok: false; error: string };

/** Whether a version falls in a range, with the sentence explaining the answer. */
export interface RangeVerdict {
  covered: boolean;
  reason: string;
}

const CLAUSE = /^(>=|<=|>|<|=)?\s*(.+)$/;

export function parseRange(range: string): ParsedRange {
  const trimmed = range.trim();
  if (trimmed === '') return { ok: false, error: 'a version range cannot be empty' };
  // '*' is its own clause list rather than a wildcard clause, so every other
  // code path can assume a clause has a real version to compare against.
  if (trimmed === '*') return { ok: true, clauses: [] };

  const clauses: RangeClause[] = [];
  for (const token of trimmed.split(/\s+/)) {
    if (token.includes('||')) {
      return { ok: false, error: "'||' is not supported: write one statement per range" };
    }
    if (/^[~^]/.test(token)) {
      return {
        ok: false,
        error: `'${token}' uses a caret or tilde, whose meaning differs by ecosystem — write explicit comparators`,
      };
    }
    const match = CLAUSE.exec(token);
    if (!match) return { ok: false, error: `'${token}' is not a comparator` };
    const version = match[2]!.trim();
    if (parseVersion(version) === null) {
      return { ok: false, error: `'${version}' is not a version this range grammar can compare` };
    }
    clauses.push({ op: (match[1] as Comparator | undefined) ?? '=', version });
  }
  return { ok: true, clauses };
}

export function versionInRange(version: string, range: string): RangeVerdict {
  const parsed = parseRange(range);
  if (!parsed.ok) {
    return { covered: false, reason: `the stored range '${range}' is unreadable: ${parsed.error}` };
  }
  // '*' IS CHECKED BEFORE THE VERSION IS PARSED, and that is not a hole in the
  // fail-safe below. The two are different questions: '*' is an author saying
  // no version of this package is affected, which needs no comparison to apply
  // because there is nothing to compare it against.
  if (parsed.clauses.length === 0) {
    return { covered: true, reason: `'${range}' covers every version of this package` };
  }
  if (parseVersion(version) === null) {
    return {
      covered: false,
      reason: `the installed version '${version}' cannot be compared, so no statement is treated as covering it`,
    };
  }

  for (const clause of parsed.clauses) {
    if (!satisfies(version, clause)) {
      return {
        covered: false,
        reason: `${version} fails '${clause.op}${clause.version}' in the covered range '${range}'`,
      };
    }
  }
  return { covered: true, reason: `${version} is inside the covered range '${range}'` };
}

function satisfies(version: string, clause: RangeClause): boolean {
  const order = compareVersions(version, clause.version);
  switch (clause.op) {
    case '=':
      return order === 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
  }
}

interface Segment {
  number: number;
  /** Whatever trailed the digits — 'rc1' in '2.0.0rc1'. */
  suffix: string;
}

interface Version {
  release: Segment[];
  /** Dot-separated identifiers after a '-'. Empty means this is a real release. */
  prerelease: string[];
}

/**
 * Parses the version shapes the ecosystems we scan actually produce.
 *
 * Returns null rather than guessing. A git sha, a `file:` specifier or an epoch
 * like PEP 440's `1!2.0` all land here, and each of them means the comparison
 * cannot be made — which the caller reports rather than papers over.
 */
export function parseVersion(raw: string): Version | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Build metadata is explicitly not part of precedence in semver, and no
  // ecosystem orders by it, so it is dropped before anything else looks.
  const withoutBuild = trimmed.split('+')[0]!;
  const stripped = withoutBuild.replace(/^v/, '');
  const dash = stripped.indexOf('-');
  const releasePart = dash === -1 ? stripped : stripped.slice(0, dash);
  const prerelease =
    dash === -1
      ? []
      : stripped
          .slice(dash + 1)
          .split('.')
          .filter(Boolean);

  const release: Segment[] = [];
  for (const piece of releasePart.split('.')) {
    const match = /^(\d+)([A-Za-z0-9]*)$/.exec(piece);
    if (!match) return null;
    release.push({ number: Number(match[1]), suffix: match[2] ?? '' });
  }
  if (release.length === 0) return null;
  return { release, prerelease };
}

/** -1, 0 or 1. Both arguments must have parsed; callers check first. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    throw new Error(`compareVersions called with an unparseable version: '${a}' vs '${b}'`);
  }

  const length = Math.max(left.release.length, right.release.length);
  for (let i = 0; i < length; i += 1) {
    // A missing segment is zero: '1.2' and '1.2.0' are the same release, which
    // is what every ecosystem here means by them.
    const l = left.release[i] ?? { number: 0, suffix: '' };
    const r = right.release[i] ?? { number: 0, suffix: '' };
    if (l.number !== r.number) return l.number < r.number ? -1 : 1;
    if (l.suffix !== r.suffix) {
      // '2.0.0' outranks '2.0.0rc1': an empty suffix is the finished release,
      // and a suffixed one is something on the way to it.
      if (l.suffix === '') return 1;
      if (r.suffix === '') return -1;
      return l.suffix < r.suffix ? -1 : 1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  // Same rule as the suffix, one level up: 1.0.0 is later than 1.0.0-beta.
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
      continue;
    }
    // Numeric identifiers sort below alphanumeric ones, as semver §11 has it.
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * The versionless purl a statement is keyed on.
 *
 * `pkg:npm/jquery@3.4.1?package-id=abc` becomes `pkg:npm/jquery`. Both the
 * version and syft's qualifiers have to go: the version is what the RANGE is
 * for, and `package-id` is a hash of the catalogued location that changes when
 * the file moves, so keying on it would make every statement stop applying the
 * first time a lockfile was reorganised.
 */
export function basePurl(purl: string): string {
  const withoutQualifiers = purl.split('?')[0]!.split('#')[0]!;
  const at = withoutQualifiers.lastIndexOf('@');
  const slash = withoutQualifiers.lastIndexOf('/');
  return at > slash ? withoutQualifiers.slice(0, at) : withoutQualifiers;
}
