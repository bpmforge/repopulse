import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dedupKey } from '@repopulse/insights';
import { cveIdFor, parseGrypeMatches, severityFromLabel } from './matches.js';
import { resolveScopes } from '../../registers/sbom.js';
import { dependencyFindings, manifestPaths, DEPENDENCY_SCANNER_KEY } from './findings.js';
import { validateVulnerabilities } from '../../validation/index.js';
import { checkVulnDb, runDependencyTools } from './tools.js';

// The dependency scanner (W8-06, FR-SEC-5, D12).
//
// EVERY FIXTURE HERE WAS CAPTURED FROM A REAL RUN — syft 1.51.0 and grype
// 0.117.0, offline, under the §2.2 profile, against the jquery 3.4.1 tree in
// fixtures/dependency/vulnerable. Hand-written match JSON would let this file
// pass while asserting a shape grype does not emit, which is exactly how the
// `vulnerability.kev` mistake in the ticket brief survived as long as it did.

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/dependency',
);

const grypeJson = readFileSync(path.join(FIXTURES, 'jquery-grype.json'), 'utf8');
const sbom = JSON.parse(
  readFileSync(path.join(FIXTURES, 'jquery-sbom.cyclonedx.json'), 'utf8'),
) as Record<string, unknown>;

describe('reading grype output', () => {
  it('finds CVE-2020-11023 behind its GHSA id', () => {
    // grype's own id is GHSA-jpcq-cgw6-v4j6. A reader that stored `id` as the
    // CVE would file every npm finding with a null cve_id, and the Security
    // tab's CVE column would be empty on a repository full of CVEs.
    const { matches } = parseGrypeMatches(grypeJson);
    const cves = matches.map((m) => m.cveId);
    expect(cves).toContain('CVE-2020-11023');
    expect(matches.every((m) => m.vulnerabilityId.startsWith('GHSA-'))).toBe(true);
  });

  it('reads KEV off knownExploited[], the field grype actually emits', () => {
    // The regression this test exists for: `vulnerability.kev` does not exist,
    // and reading it printed "kev matches: 0" on a KEV-carrying package.
    const { matches } = parseGrypeMatches(grypeJson);
    const kevMatch = matches.find((m) => m.cveId === 'CVE-2020-11023');
    expect(kevMatch?.kev).toBe(true);

    const notKev = matches.find((m) => m.cveId === 'CVE-2020-11022');
    expect(notKev?.kev).toBe(false);
  });

  it('reads EPSS off epss[], which is an array and not a scalar', () => {
    const { matches } = parseGrypeMatches(grypeJson);
    const kevMatch = matches.find((m) => m.cveId === 'CVE-2020-11023');
    expect(kevMatch?.epss).toBeGreaterThan(0);
    expect(kevMatch?.epss).toBeLessThanOrEqual(1);
  });

  it('THROWS on output it cannot read rather than returning no matches', () => {
    // "grype found nothing" and "grype output was unreadable" must never look
    // the same; the caller turns this throw into a failed scan_run.
    expect(() => parseGrypeMatches('{"not":"a report"}')).toThrow(/matches/);
    expect(() => parseGrypeMatches('nonsense')).toThrow();
  });

  it('collapses two providers reporting one (package, CVE) and COUNTS it', () => {
    const doubled = JSON.parse(grypeJson) as { matches: unknown[] };
    doubled.matches = [...doubled.matches, ...doubled.matches];
    const { matches, funnel } = parseGrypeMatches(JSON.stringify(doubled));
    expect(funnel.rawMatches).toBe(4);
    expect(matches).toHaveLength(2);
    expect(funnel.duplicatesCollapsed).toBe(2);
  });

  it('files an unscored severity at 3, never at 1', () => {
    // A CVE nobody has scored yet is unscored, not harmless. Filing it as info
    // would sort the newest vulnerabilities to the bottom of the list on the
    // day they matter most.
    expect(severityFromLabel('Critical').severity).toBe(5);
    expect(severityFromLabel('Negligible').severity).toBe(1);
    expect(severityFromLabel('Unknown')).toEqual({ severity: 3, unknown: true });
    expect(severityFromLabel('')).toEqual({ severity: 3, unknown: true });
  });

  it('recovers a CVE from the KEV row when nothing else carries one', () => {
    expect(cveIdFor({ id: 'GHSA-x', knownExploited: [{ cve: 'CVE-2021-44228' }] }, [])).toBe(
      'CVE-2021-44228',
    );
    expect(cveIdFor({ id: 'GHSA-x' }, [])).toBeNull();
  });
});

describe('matches -> findings', () => {
  const { matches } = parseGrypeMatches(grypeJson);
  // W8-13: findings are built from VALIDATED vulnerabilities, so this goes
  // through the funnel the way production does. The fixture directory IS the
  // snapshot — it holds the lockfile V1 reads and the sources V2 scans.
  const validated = validateVulnerabilities({
    matches,
    snapshotDir: path.join(FIXTURES, 'vulnerable'),
    goReachability: null,
  });
  const { findings, funnel, reviewedFiles } = dependencyFindings(validated.vulnerabilities, sbom);

  it('produces one finding per (package, CVE), carrying the CVE id', () => {
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.cveId).sort()).toEqual(['CVE-2020-11022', 'CVE-2020-11023']);
    expect(findings.every((f) => f.dimension === 'dependency')).toBe(true);
    expect(findings.every((f) => f.scannerKey === DEPENDENCY_SCANNER_KEY)).toBe(true);
  });

  it('keeps two CVEs on one package as two rows', () => {
    // dedupKey normalizes DIGITS out of the evidence quote, so
    // "CVE-2020-11023" and "CVE-2020-11022" normalize to the same string. The
    // rule id is what keeps them apart; without it one of these findings would
    // silently vanish into the other.
    const keys = findings.map((f) =>
      dedupKey({
        dimension: f.dimension,
        file: f.file,
        evidenceQuote: f.evidenceQuote,
        lineStart: f.lineStart,
        scannerKey: f.scannerKey ?? null,
        ruleId: f.ruleId ?? null,
      }),
    );
    expect(new Set(keys).size).toBe(2);
  });

  it('does not put the EPSS score in the evidence, because it moves daily', () => {
    // The dedup key is built from the evidence quote. A number that changes
    // every night in there would re-key the same finding every night and grow
    // the list without anything changing in the repository.
    expect(findings.every((f) => !/EPSS/i.test(f.evidenceQuote))).toBe(true);
    expect(findings.some((f) => /EPSS/i.test(f.rationale))).toBe(true);
  });

  it('floors a KEV finding at severity 4 and flags kev in yields', () => {
    // Two levers, not one: this is the severity a reader sorts by, and
    // price.ts SEPARATELY forces likelihood 1 and the act band on kev:true.
    const kev = findings.find((f) => f.cveId === 'CVE-2020-11023');
    expect(kev?.severity).toBeGreaterThanOrEqual(4);
    expect(kev?.yields?.['kev']).toBe(true);
    expect(funnel.kevFloored).toBe(1);

    const notKev = findings.find((f) => f.cveId === 'CVE-2020-11022');
    expect(notKev?.yields?.['kev']).toBeUndefined();
    expect(notKev?.severity).toBe(3);
  });

  it('carries the D12 pricing inputs and claims no more than the tiers proved', () => {
    // W8-06 stamped 'manifest_only' on everything because an SBOM cannot
    // support more. W8-13's V2 CAN: jquery is required in src/index.js, so the
    // claim rises to 'imported' — which still says nothing about whether the
    // vulnerable FUNCTION is called, and never becomes 'symbol_reachable'
    // without a call-graph proof that no JavaScript tool here can produce.
    const finding = findings[0]!;
    expect(finding.yields?.['reachability']).toBe('imported');
    expect(finding.yields?.['usage']).toBe('imported');
    expect(finding.yields?.['epss']).toBeTypeOf('number');
    expect(finding.yields?.['dep_scope']).toEqual({ kind: 'prod-direct', depth: 1 });
    expect(
      findings.every((f) => f.yields?.['reachability'] !== 'symbol_reachable'),
    ).toBe(true);
  });

  it('scopes EVERY component prod-direct today, transitive ones included', () => {
    // A LIMITATION, PINNED — not a property anyone wants. The fixture's real
    // dependency graph is `root -> debug -> ms`, so `ms` is transitive at depth
    // 2, and the SBOM says so. resolveScopes still returns depth 1 for it,
    // because syft's CycloneDX root component is the scanned DIRECTORY
    // (type 'file', name '/scan') and that bom-ref appears nowhere in
    // `dependencies[]` — the walk starts from a node with no edges and every
    // component falls through to its default.
    //
    // Consequence worth stating plainly: D12's depth ramp is dead code for
    // dependency findings, and prod-direct/prod-transitive/dev have collapsed
    // into one value. The fix is in registers/sbom.ts, outside this ticket.
    // Asserted so that fixing it fails this test instead of silently changing
    // every dependency score overnight.
    const graph = sbom['dependencies'] as { ref: string; dependsOn: string[] }[];
    expect(graph.some((n) => n.ref.includes('debug') && n.dependsOn[0]?.includes('ms'))).toBe(true);

    const scopes = resolveScopes(sbom);
    expect(scopes.find((c) => c.name === 'ms')).toMatchObject({ scope: 'prod-direct', depth: 1 });
  });

  it('reports the syncable component count next to the document\'s own', () => {
    // The document counts the root project and a file entry per manifest, so
    // its count reads as far too many for one dependency. Both numbers are
    // reported; neither is silently substituted for the other.
    expect(funnel.syncableComponents).toBeLessThan(
      (sbom['components'] as unknown[]).length,
    );
    expect(funnel.syncableComponents).toBeGreaterThan(0);
  });

  it('emits the chainer term as a boolean key, and nothing else the chainer reads', () => {
    // The chainer takes only keys whose value is `true`. That is why the
    // pricing inputs can share this column: a number or a string is invisible
    // to it, so `epss` and `reachability` cannot become chain vocabulary.
    const terms = Object.entries(findings[0]!.yields ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    // W8-13 added aliases, usage, evidence and VEX proposals to this column;
    // none of them may become chain vocabulary, which is what this asserts.

    expect(terms).toContain(`vuln-dependency:${findings[0]!.cveId}`);
    expect(terms.every((t) => t === 'kev' || t.startsWith('vuln-dependency:'))).toBe(true);
  });

  it('points at the lockfile it read, so the stale sweep can close it later', () => {
    expect(findings.every((f) => f.file === 'package-lock.json')).toBe(true);
    expect(reviewedFiles).toContain('package-lock.json');
  });

  it('reports an unscopable ecosystem instead of dropping it', () => {
    // resolveScopes admits only pkg:npm and pkg:pypi; grype matches maven, go
    // and every OS package too. Dropping those would make a Java repository
    // look clean.
    const maven = validateVulnerabilities({
      matches: [
        {
          ...matches[0]!,
          packageType: 'java-archive',
          packageName: 'log4j-core',
          purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1',
        },
      ],
      snapshotDir: path.join(FIXTURES, 'vulnerable'),
      goReachability: null,
    });
    const result = dependencyFindings(maven.vulnerabilities, sbom);
    expect(result.findings).toHaveLength(1);
    expect(result.funnel.withoutScope).toBe(1);
    expect(result.findings[0]!.yields?.['dep_scope']).toBeUndefined();
    // AND it is reported as an ecosystem we cannot read, not as a package that
    // is absent — the two would propose very different things to a triager.
    expect(maven.funnel.scoped.unreadable).toBe(1);
    expect(maven.funnel.scoped.notInResolvedSet).toBe(0);
    expect(maven.vulnerabilities[0]!.proposals).toEqual([]);
  });

  it('reads the manifest paths out of the SBOM, not out of the matches', () => {
    // A repository with zero vulnerabilities still has to report which files
    // it read, or persistFindings has nothing to sweep and the last CVE a repo
    // ever had would stay open after it was fixed.
    expect(manifestPaths(sbom)).toEqual(['package-lock.json']);
    expect(dependencyFindings([], sbom).reviewedFiles).toEqual(['package-lock.json']);
  });
});

describe('the database precheck', () => {
  it('refuses when there is no database, with the sync command in the reason', () => {
    const missing = checkVulnDb(path.join(tmpdir(), 'w8-06-definitely-not-here'));
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reason).toMatch(/scan-db-sync/);
  });

  it('refuses a directory that exists but holds no vulnerability.db', () => {
    // The half-finished sync. Without this check grype starts, finds nothing,
    // and the repository reports clean.
    const dir = mkdtempSync(path.join(tmpdir(), 'w8-06-db-'));
    expect(checkVulnDb(dir).ok).toBe(false);
  });

  it('discovers the schema directory rather than pinning its number', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'w8-06-db-'));
    mkdirSync(path.join(dir, '6'));
    writeFileSync(path.join(dir, '6', 'vulnerability.db'), 'not really a database');
    expect(checkVulnDb(dir)).toEqual({ ok: true, schema: '6' });
  });
});

/** A container stand-in that prints exactly what the real one would. */
function fakeContainer(
  stdout: string,
): NonNullable<Parameters<typeof runDependencyTools>[0]['spawnFn']> {
  return ((_cmd: string, _argv: string[], opts: object) =>
    spawn(
      process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
      opts,
    )) as never;
}

describe('a tool that did not run fails the scan', () => {
  const dbDir = (() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'w8-06-db-'));
    mkdirSync(path.join(dir, '6'));
    writeFileSync(path.join(dir, '6', 'vulnerability.db'), 'stand-in');
    return dir;
  })();

  const run = async (stdout: string) =>
    await runDependencyTools({
      targetDir: FIXTURES,
      image: 'localhost/repopulse/scan:test',
      vulnDb: dbDir,
      budget: { wallClockMs: 30_000 },
      spawnFn: fakeContainer(stdout),
    });

  it('fails when syft exits non-zero, even though grype exits 0 on empty input', () => {
    // THE BUG THIS SHAPE EXISTS TO PREVENT. Piped, a dead syft hands grype an
    // empty stdin and grype reports zero matches with status 0 — a repository
    // that comes back clean because the SBOM step crashed.
    return run('SYFT_EXIT=1\n===SBOM===\n===GRYPE===\n{"matches":[]}\nGRYPE_EXIT=0\n').then(
      (result) => {
        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/syft exited 1/);
        expect(result.matches).toEqual([]);
      },
    );
  });

  it('fails when grype exits non-zero', async () => {
    const result = await run(
      `SYFT_EXIT=0\n===SBOM===\n${JSON.stringify(sbom)}\n===GRYPE===\nGRYPE_EXIT=2\n`,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/grype exited 2/);
  });

  it('fails on truncated output rather than reporting what arrived', async () => {
    const result = await run('SYFT_EXIT=0\n===SBOM===\n{"components":[]}\n');
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/exit code/);
  });

  it('fails when the SBOM is not JSON', async () => {
    const result = await run(
      'SYFT_EXIT=0\n===SBOM===\nnot json\n===GRYPE===\n{"matches":[]}\nGRYPE_EXIT=0\n',
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/SBOM was not JSON/);
  });

  it('succeeds, with the funnel filled in, when both tools ran', async () => {
    const result = await run(
      `SYFT_EXIT=0\n===SBOM===\n${JSON.stringify(sbom)}\n===GRYPE===\n${grypeJson}\nGRYPE_EXIT=0\n`,
    );
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.componentCount).toBe(5);
    expect(result.matches).toHaveLength(2);
    expect(result.matchFunnel?.rawMatches).toBe(2);
    // Versions read off the tools' OWN output, so what is stamped on the run is
    // what actually ran rather than what this file believes is installed.
    expect(result.toolVersions['grype']).toBe('0.117.0');
    expect(result.toolVersions['syft']).not.toBe('unknown');
  });

  it('refuses to start a container at all when there is no database', async () => {
    const result = await runDependencyTools({
      targetDir: FIXTURES,
      image: 'localhost/repopulse/scan:test',
      vulnDb: path.join(tmpdir(), 'w8-06-no-db-here'),
      budget: { wallClockMs: 30_000 },
      spawnFn: fakeContainer(
        'SYFT_EXIT=0\n===SBOM===\n{}\n===GRYPE===\n{"matches":[]}\nGRYPE_EXIT=0\n',
      ),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no vulnerability database/);
  });
});
