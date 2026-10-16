import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DependencyMatch } from '../scanners/dependency/matches.js';
import { runSemgrepScan, type SemgrepRunArgs, type SemgrepRunResult } from '../scanners/semgrep/scanner.js';
import { scopeEcosystemOf } from './scope.js';
import {
  moduleOf,
  reachRuleId,
  SYMBOL_CATALOGUE,
  type SymbolEntry,
} from './symbols.js';
import type { CallSite } from './types.js';

// V3 for npm and PyPI (W18-46): call-site proof from the generated pack.
//
// Go gets a call graph from govulncheck. Here the evidence is weaker and is
// labelled so: Opengrep finds CALLS to the functions an advisory names. A call
// upgrades a finding to 'symbol_reachable' ("your code calls the vulnerable
// function"). The absence of a call changes nothing: dynamic access,
// re-exports and a transitive caller are all invisible to a text-level call
// search, so this tier never answers 'proven_unreachable'.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REACH_RULEPACK_DIR = path.resolve(HERE, '../../rulepacks/reachability');
export const REACH_RULEPACK_FILE = 'bpm-reach.v1.yaml';

/** A call to a catalogued symbol, found in the snapshot. */
export interface SymbolCall {
  ruleId: string;
  package: string;
  symbol: string;
  file: string;
  line: number;
}

export interface SymbolReachabilityResult {
  status: 'succeeded' | 'skipped' | 'failed';
  calls: SymbolCall[];
  toolVersion: string | null;
  /** Why nothing ran or the run failed. Always set unless 'succeeded'. */
  reason: string | null;
  /** Catalogued packages present in the scan, searched for. */
  packagesSearched: string[];
}

const normalize = (ecosystem: 'npm' | 'pypi', name: string): string => {
  const lower = name.toLowerCase();
  return ecosystem === 'pypi' ? lower.replace(/[-_.]+/g, '-') : lower;
};

/** Catalogue entries whose package is among the matches, for the matched ecosystem. */
export function applicableEntries(
  matches: readonly Pick<DependencyMatch, 'packageName' | 'packageType'>[],
  catalogue: readonly SymbolEntry[] = SYMBOL_CATALOGUE,
): SymbolEntry[] {
  const present = new Set<string>();
  for (const m of matches) {
    const eco = scopeEcosystemOf(m.packageType);
    if (eco === 'npm' || eco === 'pypi') present.add(`${eco}\0${normalize(eco, m.packageName)}`);
  }
  return catalogue.filter((e) => present.has(`${e.ecosystem}\0${normalize(e.ecosystem, e.package)}`));
}

export interface SymbolReachabilityArgs {
  targetDir: string;
  matches: readonly Pick<DependencyMatch, 'packageName' | 'packageType'>[];
  image: string;
  budget: SemgrepRunArgs['budget'];
  catalogue?: readonly SymbolEntry[];
  /** Test seam: the Opengrep run. Production always goes through the sandbox. */
  run?: (args: SemgrepRunArgs) => Promise<SemgrepRunResult>;
}

/**
 * Runs the generated pack, only when a catalogued package is in the scan: a
 * repository with none of them costs no container start.
 */
export async function symbolReachability(
  args: SymbolReachabilityArgs,
): Promise<SymbolReachabilityResult> {
  const entries = applicableEntries(args.matches, args.catalogue);
  if (entries.length === 0) {
    return {
      status: 'skipped',
      calls: [],
      toolVersion: null,
      reason: 'no vulnerable package in this scan has affected-symbol data',
      packagesSearched: [],
    };
  }
  const run = args.run ?? runSemgrepScan;
  const result = await run({
    targetDir: args.targetDir,
    budget: args.budget,
    image: args.image,
    rulepackDir: REACH_RULEPACK_DIR,
    rulepackFiles: (f) => f === REACH_RULEPACK_FILE,
  });
  const packagesSearched = entries.map((e) => e.package).sort();
  if (result.status !== 'succeeded') {
    return {
      status: 'failed',
      calls: [],
      toolVersion: null,
      reason: result.error ?? `symbol search ${result.status}`,
      packagesSearched,
    };
  }

  // Only the rules of the packages that matter, though the engine ran them all.
  const wanted = new Map<string, { entry: SymbolEntry; symbol: string }>();
  for (const entry of entries) {
    for (const advisory of entry.advisories) {
      for (const symbol of advisory.symbols) {
        wanted.set(reachRuleId(entry, symbol), { entry, symbol });
      }
    }
  }
  const calls: SymbolCall[] = [];
  const seen = new Set<string>();
  for (const f of result.findings) {
    const hit = wanted.get(f.ruleId);
    if (!hit) continue;
    const key = `${f.ruleId}\0${f.file}\0${f.lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({
      ruleId: f.ruleId,
      package: hit.entry.package,
      symbol: hit.symbol,
      file: f.file,
      line: f.lineStart,
    });
  }
  calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
  return {
    status: 'succeeded',
    calls,
    toolVersion: result.toolVersions['opengrep'] ?? null,
    reason: null,
    packagesSearched,
  };
}

/**
 * Call sites for one vulnerability: calls to a symbol the advisory (any id the
 * vulnerability is known by) names, in the matched package. Joined on advisory
 * AND package, so one package's call is never credited to another advisory.
 */
export function callsFor(
  result: SymbolReachabilityResult,
  match: Pick<DependencyMatch, 'packageName' | 'packageType'>,
  ids: readonly string[],
  catalogue: readonly SymbolEntry[] = SYMBOL_CATALOGUE,
): CallSite[] {
  const eco = scopeEcosystemOf(match.packageType);
  if (eco !== 'npm' && eco !== 'pypi') return [];
  const upper = new Set(ids.map((id) => id.toUpperCase()));
  const sites: CallSite[] = [];
  for (const entry of catalogue) {
    if (entry.ecosystem !== eco) continue;
    if (normalize(eco, entry.package) !== normalize(eco, match.packageName)) continue;
    for (const advisory of entry.advisories) {
      if (!advisory.ids.some((id) => upper.has(id.toUpperCase()))) continue;
      for (const symbol of advisory.symbols) {
        const rule = reachRuleId(entry, symbol);
        for (const call of result.calls) {
          if (call.ruleId !== rule) continue;
          sites.push({ file: call.file, line: call.line, symbol: `${moduleOf(entry)}.${symbol}` });
        }
      }
    }
  }
  const unique = new Map(sites.map((s) => [`${s.file}\0${s.line}\0${s.symbol}`, s]));
  return [...unique.values()];
}

/** Does the catalogue hold symbol data for this advisory in this package? */
export function hasSymbolData(
  match: Pick<DependencyMatch, 'packageName' | 'packageType'>,
  ids: readonly string[],
  catalogue: readonly SymbolEntry[] = SYMBOL_CATALOGUE,
): boolean {
  const eco = scopeEcosystemOf(match.packageType);
  if (eco !== 'npm' && eco !== 'pypi') return false;
  const upper = new Set(ids.map((id) => id.toUpperCase()));
  return catalogue.some(
    (e) =>
      e.ecosystem === eco &&
      normalize(eco, e.package) === normalize(eco, match.packageName) &&
      e.advisories.some((a) => a.ids.some((id) => upper.has(id.toUpperCase()))),
  );
}
