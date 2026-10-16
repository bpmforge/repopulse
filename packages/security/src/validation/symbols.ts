// Affected-symbol catalogue and the rule pack generated from it (W18-46).
//
// V3 for Go asks govulncheck whether our code can reach the vulnerable
// function. Nothing equivalent exists for JavaScript/TypeScript or Python, and
// the data that would drive one is mostly missing: OSV carries
// `ecosystem_specific.imports[].symbols` for Go, and for npm and PyPI almost
// no advisory names a function at all. So this tier is deliberately narrow:
//
//   - a CATALOGUE of advisories where the affected function IS public and
//     named (lodash's `template`, PyYAML's `load`, ...), each entry carrying the
//     advisory ids it applies to;
//   - a RULE PACK generated from it, one Opengrep rule per package symbol,
//     matching call sites however the symbol was imported;
//   - a proof that only ever goes UP. A call site is evidence the vulnerable
//     function is used ('symbol_reachable'). No call site is NOT evidence it is
//     unused (dynamic access, re-exports, a transitive caller), so nothing
//     here ever answers 'proven_unreachable'; a package we found no call to
//     stays at 'imported', exactly as before.
//
// A call site is also not proof of exploitability: it shows the function is
// called, not that attacker data reaches it. The finding text says so.

export type SymbolEcosystem = 'npm' | 'pypi';

export interface SymbolAdvisory {
  /** Every id this advisory is known by; joined case-insensitively to grype's. */
  ids: string[];
  /** The public functions the advisory names as vulnerable. */
  symbols: string[];
}

export interface SymbolEntry {
  ecosystem: SymbolEcosystem;
  /** The distribution name as grype reports it. */
  package: string;
  /** The name code imports it as, when that differs (PyYAML is `yaml`). */
  module?: string;
  advisories: SymbolAdvisory[];
  /**
   * The package also publishes each symbol as its own module whose default
   * export is the function (`lodash/template`).
   */
  subpathModules?: boolean;
  /**
   * The package's own export is the function (`minimist(argv)`). `symbols` then
   * holds the single name `default`.
   */
  callableExport?: boolean;
  /**
   * Call shapes that look like a symbol call and do not reach the advisory
   * (`yaml.load(s, Loader=yaml.SafeLoader)`). `{mod}` and `{sym}` are filled in.
   */
  unless?: string[];
  /** Where the symbol names came from, for a reader who disagrees. */
  source: string;
}

const PYYAML_SAFE = [
  '{mod}.{sym}(..., Loader={mod}.SafeLoader)',
  '{mod}.{sym}(..., Loader={mod}.CSafeLoader)',
  '{mod}.{sym}(..., Loader={mod}.BaseLoader)',
  '{mod}.{sym}(..., {mod}.SafeLoader)',
  '{mod}.{sym}(..., {mod}.CSafeLoader)',
  '{mod}.{sym}(..., {mod}.BaseLoader)',
];

/**
 * Hand-curated from the advisory text, each row naming the function the
 * advisory says is affected. It is small on purpose: an entry whose symbol is
 * a guess would put "reachable" on a finding that is not, and that is worse
 * than no entry. Growth is by adding rows (or by `symbolsFromOsv` when a feed
 * carries the data), each with a test fixture.
 */
export const SYMBOL_CATALOGUE: readonly SymbolEntry[] = [
  {
    ecosystem: 'npm',
    package: 'lodash',
    subpathModules: true,
    source: 'GitHub Advisory Database / NVD advisory text',
    advisories: [
      { ids: ['CVE-2021-23337', 'GHSA-35jh-r3h4-6jhm'], symbols: ['template'] },
      { ids: ['CVE-2019-10744', 'GHSA-jf85-cpcp-j695'], symbols: ['defaultsDeep'] },
      {
        ids: ['CVE-2018-16487', 'GHSA-4xc9-xhrj-v574'],
        symbols: ['merge', 'mergeWith', 'defaultsDeep'],
      },
      {
        ids: ['CVE-2018-3721', 'GHSA-fvqr-27wr-82fm'],
        symbols: ['merge', 'mergeWith', 'defaultsDeep'],
      },
      { ids: ['CVE-2020-8203', 'GHSA-p6mc-m468-83gw'], symbols: ['zipObjectDeep'] },
      { ids: ['CVE-2020-28500', 'GHSA-29mw-wpgm-hmr9'], symbols: ['toNumber', 'trim', 'trimEnd'] },
    ],
  },
  {
    ecosystem: 'npm',
    package: 'underscore',
    source: 'GitHub Advisory Database / NVD advisory text',
    advisories: [{ ids: ['CVE-2021-23358', 'GHSA-cf4h-3jhx-xvhq'], symbols: ['template'] }],
  },
  {
    ecosystem: 'npm',
    package: 'minimist',
    callableExport: true,
    source: 'GitHub Advisory Database / NVD advisory text',
    advisories: [
      { ids: ['CVE-2020-7598', 'GHSA-vh95-rmgr-6w4m'], symbols: ['default'] },
      { ids: ['CVE-2021-44906', 'GHSA-xvch-5gv4-984h'], symbols: ['default'] },
    ],
  },
  {
    ecosystem: 'npm',
    package: 'node-serialize',
    source: 'GitHub Advisory Database / NVD advisory text',
    advisories: [{ ids: ['CVE-2017-5941', 'GHSA-q4v7-4rhw-9hqm'], symbols: ['unserialize'] }],
  },
  {
    ecosystem: 'npm',
    package: 'ejs',
    source: 'GitHub Advisory Database / NVD advisory text',
    advisories: [
      { ids: ['CVE-2022-29078', 'GHSA-phwq-j96m-2c2q'], symbols: ['render', 'renderFile'] },
    ],
  },
  {
    ecosystem: 'npm',
    package: 'jsonwebtoken',
    source: 'GitHub Advisory Database / NVD advisory text',
    advisories: [
      { ids: ['CVE-2022-23529', 'GHSA-27h2-hvpr-p74q'], symbols: ['verify'] },
      { ids: ['CVE-2022-23539', 'GHSA-8cf7-32gw-wr33'], symbols: ['sign', 'verify'] },
      { ids: ['CVE-2022-23540', 'GHSA-qwph-4952-7xr6'], symbols: ['verify'] },
      { ids: ['CVE-2022-23541', 'GHSA-hjrf-2m68-5959'], symbols: ['verify'] },
    ],
  },
  {
    ecosystem: 'pypi',
    package: 'PyYAML',
    module: 'yaml',
    unless: PYYAML_SAFE,
    source: 'GitHub Advisory Database / NVD advisory text',
    advisories: [
      { ids: ['CVE-2017-18342', 'GHSA-rprw-h62v-c2w7'], symbols: ['load', 'load_all'] },
      {
        ids: ['CVE-2020-1747', 'GHSA-6757-jp84-gxfx'],
        symbols: ['load', 'load_all', 'full_load', 'full_load_all'],
      },
      { ids: ['CVE-2020-14343', 'GHSA-8q59-q68h-6hv4'], symbols: ['load', 'load_all', 'full_load', 'full_load_all'] },
    ],
  },
];

/**
 * An entry from an OSV record that carries Go-style symbol data
 * (`affected[].ecosystem_specific.imports[].symbols`). npm and PyPI records
 * rarely do, so this returns null for the common case instead of an entry with
 * no symbols.
 */
export function symbolsFromOsv(record: unknown): SymbolEntry | null {
  const osv = asRecord(record);
  const ids = [osv['id'], ...asArray(osv['aliases'])].filter(
    (v): v is string => typeof v === 'string',
  );
  for (const affected of asArray(osv['affected']).map(asRecord)) {
    const pkg = asRecord(affected['package']);
    const ecosystem = pkg['ecosystem'] === 'npm' ? 'npm' : pkg['ecosystem'] === 'PyPI' ? 'pypi' : null;
    const name = typeof pkg['name'] === 'string' ? pkg['name'] : null;
    if (!ecosystem || !name) continue;
    const symbols = asArray(asRecord(affected['ecosystem_specific'])['imports'])
      .flatMap((imp) => asArray(asRecord(imp)['symbols']))
      .filter((s): s is string => typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s));
    if (symbols.length === 0) continue;
    return {
      ecosystem,
      package: name,
      advisories: [{ ids, symbols: [...new Set(symbols)].sort() }],
      source: 'OSV ecosystem_specific.imports[].symbols',
    };
  }
  return null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The name code imports a package under. */
export const moduleOf = (entry: SymbolEntry): string => entry.module ?? entry.package;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** `bpm-reach-npm-lodash-template`. Stable: a rule id is what a finding keeps. */
export function reachRuleId(entry: SymbolEntry, symbol: string): string {
  return `bpm-reach-${entry.ecosystem}-${slug(entry.package)}-${slug(symbol)}`;
}

/** Every symbol an entry names, sorted. */
export function symbolsOf(entry: SymbolEntry): string[] {
  return [...new Set(entry.advisories.flatMap((a) => a.symbols))].sort();
}

/** The entry and symbol behind a generated rule id. */
export function ruleIndex(
  catalogue: readonly SymbolEntry[] = SYMBOL_CATALOGUE,
): Map<string, { entry: SymbolEntry; symbol: string }> {
  const index = new Map<string, { entry: SymbolEntry; symbol: string }>();
  for (const entry of catalogue) {
    for (const symbol of symbolsOf(entry)) index.set(reachRuleId(entry, symbol), { entry, symbol });
  }
  return index;
}

const JS_IMPORT_FORMS = ['javascript', 'typescript'];

const yq = (s: string): string => JSON.stringify(s);

function jsPatterns(entry: SymbolEntry, symbol: string): string[][] {
  const mod = moduleOf(entry);
  const p: string[][] = [];
  if (entry.callableExport) {
    // The package IS the function: however it was bound, calling the binding calls it.
    p.push([`require(${yq(mod)})(...)`]);
    p.push([`$F = require(${yq(mod)});\n...`, '$F(...)']);
    p.push([`import $F from ${yq(mod)};\n...`, '$F(...)']);
    return p;
  }
  // Every way a named export gets bound, spelled out. The engine resolves some
  // of these on its own for plain module names and none of them for a name like
  // `node-serialize` (a dotted pattern would parse as subtraction), so one
  // family covers all packages the same way. Measured against semgrep 1.181.
  p.push([`require(${yq(mod)}).${symbol}(...)`]);
  p.push([`$X = require(${yq(mod)});\n...`, `$X.${symbol}(...)`]);
  p.push([`import $X from ${yq(mod)};\n...`, `$X.${symbol}(...)`]);
  p.push([`import * as $X from ${yq(mod)};\n...`, `$X.${symbol}(...)`]);
  p.push([`const { ${symbol} } = require(${yq(mod)});\n...`, `${symbol}(...)`]);
  p.push([`import { ${symbol} } from ${yq(mod)};\n...`, `${symbol}(...)`]);
  p.push([`import { ${symbol} as $A } from ${yq(mod)};\n...`, '$A(...)']);
  p.push([`const { ${symbol}: $A } = require(${yq(mod)});\n...`, '$A(...)']);
  if (entry.subpathModules) {
    const sub = `${mod}/${symbol}`;
    p.push([`require(${yq(sub)})(...)`]);
    p.push([`$F = require(${yq(sub)});\n...`, '$F(...)']);
    p.push([`import $F from ${yq(sub)};\n...`, '$F(...)']);
  }
  return p;
}

/** The rule's YAML block for one symbol. */
function ruleYaml(entry: SymbolEntry, symbol: string): string {
  const mod = moduleOf(entry);
  const ids = entry.advisories.filter((a) => a.symbols.includes(symbol)).flatMap((a) => a.ids);
  const lines: string[] = [];
  lines.push(`  - id: ${reachRuleId(entry, symbol)}`);
  lines.push(
    `    languages: [${entry.ecosystem === 'npm' ? JS_IMPORT_FORMS.join(', ') : 'python'}]`,
  );
  lines.push('    severity: INFO');
  lines.push(
    `    message: ${yq(`Call to ${mod}.${symbol}, a function named by ${[...new Set(ids)].join(', ')}`)}`,
  );
  lines.push('    metadata:');
  lines.push('      lifecycle: candidate');
  lines.push('      provenance: written for RepoPulse from advisory text');
  lines.push(`      package: ${yq(entry.package)}`);
  lines.push(`      symbol: ${yq(symbol)}`);
  lines.push('    pattern-either:');

  const unless =
    entry.ecosystem === 'pypi' && entry.unless
      ? entry.unless.map((t) => t.replaceAll('{mod}', mod).replaceAll('{sym}', symbol))
      : [];
  const forms: string[][] =
    entry.ecosystem === 'npm' ? jsPatterns(entry, symbol) : [[`${mod}.${symbol}(...)`]];
  for (const form of forms) {
    const [inside, call] = form.length === 2 ? [form[0]!, form[1]!] : [null, form[0]!];
    lines.push('      - patterns:');
    if (inside) {
      lines.push('          - pattern-inside: |');
      for (const l of inside.split('\n')) lines.push(`              ${l}`);
    }
    lines.push(`          - pattern: ${yq(call)}`);
    for (const u of unless) lines.push(`          - pattern-not: ${yq(u)}`);
  }
  return lines.join('\n');
}

/** The committed pack: `rulepacks/reachability/bpm-reach.v1.yaml`. */
export function renderReachPack(catalogue: readonly SymbolEntry[] = SYMBOL_CATALOGUE): string {
  const head = [
    '# bpm-rulepacks — symbol reachability for npm and PyPI (W18-46).',
    '#',
    '# GENERATED from src/validation/symbols.ts by `pnpm --filter @repopulse/security',
    '# reach:generate`; do not edit by hand. A test holds this file equal to its',
    '# rendering.',
    '#',
    '# Each rule matches a CALL to a function an advisory names as vulnerable. These',
    '# rules are evidence only: a match upgrades a dependency finding to',
    '# symbol_reachable; no match changes nothing, and nothing here ever dismisses',
    '# a finding. They produce no findings of their own.',
    '#',
    '# PROVENANCE: written for RepoPulse from advisory text; not derived from the',
    '# Semgrep registry.',
    'rules:',
  ];
  const rules: string[] = [];
  for (const entry of catalogue) {
    for (const symbol of symbolsOf(entry)) rules.push(ruleYaml(entry, symbol));
  }
  return `${head.join('\n')}\n${rules.join('\n')}\n`;
}
