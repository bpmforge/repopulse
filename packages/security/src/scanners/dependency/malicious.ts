import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { dedupKey, priceFinding, type IncomingFinding, type PricedFinding } from '@repopulse/insights';
import { DEPENDENCY_SCANNER_KEY, type PricedIncomingFinding } from './findings.js';

// OpenSSF malicious-package matching (W18-37).
//
// A malicious package has no CVE: it IS the attack, so the grype database does
// not carry it. deploy/scan-db-sync.sh builds a compact index from the OpenSSF
// malicious-packages feed (republished as MAL-* advisories by osv.dev), and this
// file matches the SBOM against it. A hit is severity 5: installing the package
// is the compromise, whatever it is imported by or whether anything calls it.
//
// An index that is missing or unreadable is reported, never read as "no
// malicious packages" — the same rule as the vulnerability database.

export interface MaliciousAdvisory {
  id: string;
  summary: string;
  /** Affected versions, or null when every version is. */
  versions: string[] | null;
}

export interface MaliciousIndex {
  generated: string;
  source: string;
  /** OSV ecosystem -> lowercased package name -> advisories. */
  entries: Record<string, Record<string, MaliciousAdvisory[]>>;
}

export function maliciousIndexPath(): string {
  return path.join(process.env.SCAN_RULES_DIR ?? '/var/lib/repopulse/scan-rules', 'malicious', 'index.json');
}

export type IndexLoad =
  | { ok: true; index: MaliciousIndex; ageDays: number }
  | { ok: false; reason: string };

export function loadMaliciousIndex(file: string = maliciousIndexPath()): IndexLoad {
  if (!existsSync(file)) {
    return {
      ok: false,
      reason: 'The OpenSSF malicious-package index is not synced here, so malicious packages were not checked — run deploy/scan-db-sync.sh.',
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MaliciousIndex;
    if (typeof parsed.entries !== 'object' || parsed.entries === null) throw new Error('no entries');
    const ageDays = Math.floor((Date.now() - statSync(file).mtimeMs) / 86_400_000);
    return { ok: true, index: parsed, ageDays };
  } catch (error) {
    return {
      ok: false,
      reason: `The OpenSSF malicious-package index could not be read (${(error as Error).message.slice(0, 120)}), so malicious packages were not checked.`,
    };
  }
}

/** purl type -> OSV ecosystem name. */
const PURL_ECOSYSTEM: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  cargo: 'crates.io',
  gem: 'RubyGems',
  nuget: 'NuGet',
  golang: 'Go',
  maven: 'Maven',
};

export interface SbomPackage {
  ecosystem: string;
  name: string;
  version: string | null;
  purl: string;
  /** Snapshot-relative manifest syft recorded, when it recorded one. */
  file: string | null;
}

export function packagesFromSbom(document: Record<string, unknown>): SbomPackage[] {
  const out: SbomPackage[] = [];
  const components = Array.isArray(document['components']) ? document['components'] : [];
  for (const entry of components) {
    const component = entry as {
      purl?: unknown;
      version?: unknown;
      properties?: { name?: string; value?: string }[];
    };
    if (typeof component.purl !== 'string') continue;
    const m = /^pkg:([a-z]+)\/([^@?#]+)(?:@([^?#]+))?/.exec(component.purl);
    const ecosystem = m ? PURL_ECOSYSTEM[m[1]!] : undefined;
    if (!m || !ecosystem) continue;
    let name = decodeURIComponent(m[2]!);
    // Maven purls are group/artifact; OSV names them group:artifact.
    if (ecosystem === 'Maven') name = name.replace('/', ':');
    const location = (component.properties ?? []).find(
      (p) => typeof p.name === 'string' && /^syft:location:\d+:path$/.test(p.name),
    )?.value;
    out.push({
      ecosystem,
      name,
      version: typeof component.version === 'string' ? component.version : m[3] ? decodeURIComponent(m[3]) : null,
      purl: component.purl,
      file: location ? location.replace(/^\/+/, '') : null,
    });
  }
  return out;
}

export interface MaliciousHit {
  pkg: SbomPackage;
  advisory: MaliciousAdvisory;
}

export function matchMalicious(packages: readonly SbomPackage[], index: MaliciousIndex): MaliciousHit[] {
  const hits: MaliciousHit[] = [];
  for (const pkg of packages) {
    const advisories = index.entries[pkg.ecosystem]?.[pkg.name.toLowerCase()];
    if (!advisories) continue;
    for (const advisory of advisories) {
      // `versions: null` means every version; a listed set must contain this one.
      // A component with no version cannot be cleared by a list, so it matches.
      if (advisory.versions === null || pkg.version === null || advisory.versions.includes(pkg.version)) {
        hits.push({ pkg, advisory });
      }
    }
  }
  return hits;
}

export function maliciousFinding(hit: MaliciousHit): PricedIncomingFinding {
  const { pkg, advisory } = hit;
  const finding: IncomingFinding = {
    dimension: 'dependency',
    severity: 5,
    confidence: 5,
    file: pkg.file,
    lineStart: null,
    lineEnd: null,
    title: `${advisory.id}: ${pkg.name} ${pkg.version ?? ''} is a known malicious package`.replace('  ', ' '),
    evidenceQuote: `${pkg.purl} is listed as malicious by OpenSSF (${advisory.id})`,
    rationale:
      `${pkg.name}${pkg.version ? ` ${pkg.version}` : ''} is listed in the OpenSSF malicious-packages feed as ${advisory.id}` +
      `${advisory.summary ? `: ${advisory.summary}` : ''}. Unlike a vulnerable dependency, installing it is the compromise — ` +
      'it may already have run on developer machines and CI. Remove it, treat any environment that installed it as exposed, ' +
      'and rotate the credentials those environments held.',
    suggestedFix: `Remove ${pkg.name} and pin a known-good alternative; rotate secrets reachable from any environment that installed it.`,
    scannerKey: DEPENDENCY_SCANNER_KEY,
    ruleId: advisory.id,
    cveId: null,
    yields: { malicious_package: true, advisory: advisory.id },
  };
  const pricing: PricedFinding = priceFinding({
    dimension: 'dependency',
    severity: 5,
    confidence: 5,
    depScope: null,
    reachability: 'manifest_only',
    repoScoped: finding.file === null,
  });
  return {
    finding,
    pricing,
    key: dedupKey({
      dimension: finding.dimension,
      file: finding.file,
      evidenceQuote: finding.evidenceQuote,
      lineStart: null,
      scannerKey: DEPENDENCY_SCANNER_KEY,
      ruleId: advisory.id,
    }),
  };
}
