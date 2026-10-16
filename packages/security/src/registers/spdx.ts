// SPDX license expressions and license categories (W18-39). Pure.
//
// A POSTURE vocabulary, not legal advice: it sorts identifiers into the
// buckets a team asks about ("does this oblige us to publish our source?"),
// and resolves `OR` / `AND` / `WITH` the way the SPDX spec reads them — `OR`
// is the consumer's choice, `AND` is every term at once.

export type LicenseCategory =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'network-copyleft'
  | 'unknown';

export const LICENSE_CATEGORIES: readonly LicenseCategory[] = [
  'permissive',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'unknown',
];

/** Obligation ranking: higher binds harder. Unknown is worst, so `OR` never picks it over a known id. */
const RANK: Record<LicenseCategory, number> = {
  permissive: 0,
  'weak-copyleft': 1,
  'strong-copyleft': 2,
  'network-copyleft': 3,
  unknown: 4,
};

// Exact ids first, then prefixes. Lower-case keys; comparisons ignore case.
const EXACT: Record<string, LicenseCategory> = {
  mit: 'permissive',
  isc: 'permissive',
  '0bsd': 'permissive',
  unlicense: 'permissive',
  'cc0-1.0': 'permissive',
  zlib: 'permissive',
  'psf-2.0': 'permissive',
  'python-2.0': 'permissive',
  'bsl-1.0': 'permissive',
  wtfpl: 'permissive',
  'blueoak-1.0.0': 'permissive',
  'cc-by-3.0': 'permissive',
  'cc-by-4.0': 'permissive',
  'ofl-1.1': 'permissive',
  'apache-2.0': 'permissive',
  'apache-1.1': 'permissive',
  'artistic-2.0': 'weak-copyleft',
  'cpl-1.0': 'weak-copyleft',
  'epl-1.0': 'weak-copyleft',
  'epl-2.0': 'weak-copyleft',
  'mpl-1.1': 'weak-copyleft',
  'mpl-2.0': 'weak-copyleft',
  'cddl-1.0': 'weak-copyleft',
  'cddl-1.1': 'weak-copyleft',
  'eupl-1.1': 'strong-copyleft',
  'eupl-1.2': 'strong-copyleft',
  'sspl-1.0': 'network-copyleft',
  'osl-3.0': 'network-copyleft',
  'rpl-1.5': 'network-copyleft',
  'cc-by-sa-4.0': 'strong-copyleft',
  'cc-by-sa-3.0': 'strong-copyleft',
};

const PREFIX: [string, LicenseCategory][] = [
  ['bsd-', 'permissive'],
  ['apache-', 'permissive'],
  ['lgpl-', 'weak-copyleft'],
  ['agpl-', 'network-copyleft'],
  ['gpl-', 'strong-copyleft'],
];

/** Exceptions that turn a GPL into something linkable, i.e. weak copyleft. */
const LINKING_EXCEPTION = /classpath|linking|gcc-exception|llvm-exception|autoconf|font-exception|bison/i;

export function categoryOfId(id: string): LicenseCategory {
  const key = id.trim().toLowerCase().replace(/\+$/, '');
  if (key === '') return 'unknown';
  const exact = EXACT[key];
  if (exact) return exact;
  for (const [prefix, category] of PREFIX) if (key.startsWith(prefix)) return category;
  return 'unknown';
}

export type SpdxNode =
  | { op: 'id'; id: string; exception: string | null }
  | { op: 'and' | 'or'; left: SpdxNode; right: SpdxNode };

/** Parses an SPDX expression. Returns null for text that is not one (e.g. "SEE LICENSE IN LICENSE.md"). */
export function parseSpdx(expression: string): SpdxNode | null {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;

  const peek = (): string | undefined => tokens[at];
  const isOp = (t: string | undefined, op: string): boolean => t?.toUpperCase() === op;

  const primary = (): SpdxNode | null => {
    const token = tokens[at++];
    if (token === undefined) return null;
    if (token === '(') {
      const inner = orExpr();
      if (tokens[at++] !== ')') return null;
      return inner;
    }
    if (token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) return null;
    let exception: string | null = null;
    if (isOp(peek(), 'WITH')) {
      at += 1;
      exception = tokens[at++] ?? null;
      if (exception === null) return null;
    }
    return { op: 'id', id: token, exception };
  };
  const andExpr = (): SpdxNode | null => {
    let left = primary();
    while (left && isOp(peek(), 'AND')) {
      at += 1;
      const right = primary();
      if (!right) return null;
      left = { op: 'and', left, right };
    }
    return left;
  };
  const orExpr = (): SpdxNode | null => {
    let left = andExpr();
    while (left && isOp(peek(), 'OR')) {
      at += 1;
      const right = andExpr();
      if (!right) return null;
      left = { op: 'or', left, right };
    }
    return left;
  };

  const tree = orExpr();
  return tree && at === tokens.length ? tree : null;
}

export interface ResolvedLicense {
  category: LicenseCategory;
  /** The ids that bind once every choice is made the cheapest way. */
  ids: string[];
}

function resolveNode(node: SpdxNode): ResolvedLicense {
  if (node.op === 'id') {
    let category = categoryOfId(node.id);
    if (node.exception && LINKING_EXCEPTION.test(node.exception) && category === 'strong-copyleft') {
      category = 'weak-copyleft';
    }
    return { category, ids: [node.id.replace(/\+$/, '')] };
  }
  const left = resolveNode(node.left);
  const right = resolveNode(node.right);
  if (node.op === 'or') {
    // The consumer's choice: take the side that obliges least.
    return RANK[left.category] <= RANK[right.category] ? left : right;
  }
  // AND: both bind, so the worse category governs and every id applies.
  return {
    category: RANK[left.category] >= RANK[right.category] ? left.category : right.category,
    ids: [...left.ids, ...right.ids],
  };
}

/**
 * The category an expression resolves to, and the ids that bind.
 * Text that is not an SPDX expression resolves to `unknown`, never to permissive.
 */
export function resolveLicense(expression: string | null): ResolvedLicense {
  if (!expression || expression.trim() === '') return { category: 'unknown', ids: [] };
  const tree = parseSpdx(expression);
  if (!tree) return { category: 'unknown', ids: [expression.trim()] };
  return resolveNode(tree);
}
