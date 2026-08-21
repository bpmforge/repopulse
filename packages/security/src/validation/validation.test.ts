import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { priceFinding } from '@repopulse/insights';
import { parseGrypeMatches, type DependencyMatch } from '../scanners/dependency/matches.js';
import { dependencyFindings } from '../scanners/dependency/findings.js';
import { dedupeByAlias } from './aliases.js';
import { readResolvedSet, scopeFor } from './scope.js';
import { scanImports, usageFor } from './usage.js';
import {
  checkGoVulnDb,
  goReachability,
  parseGovulncheck,
  reachabilityFor,
} from './reachability.js';
import { validateVulnerabilities } from './validate.js';

// The CVE validation funnel (W8-13, SECURITY_SUITE.md §3.6, FR-SEC-13/15).
//
// EVERY TOOL OUTPUT IN THIS FILE WAS CAPTURED FROM A REAL RUN. The grype
// documents came from grype 0.117.0 against the synced 1.9 GB database, and the
// govulncheck documents from govulncheck v1.7.0 in source mode against the two
// Go fixtures, offline (GOPROXY=off, vendored, `-db file://` at the mini
// database in fixtures/dependency/go-vulndb). Hand-written tool JSON would let
// this file pass while asserting a shape the tools do not emit — which is
// exactly how the `vulnerability.kev` mistake survived into W8-06's brief.
//
// The exact commands are recorded next to each fixture below, because a capture
// nobody can reproduce is a fixture nobody can update.

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/dependency',
);

const read = (relative: string): string => readFileSync(path.join(FIXTURES, relative), 'utf8');

// syft scan dir:python -o cyclonedx-json | GRYPE_MATCH_PYTHON_USING_CPES=true grype sbom:… -o json
//
// CPE matching is enabled for the capture and NOT in production. It is what
// makes grype report the nvd record ALONGSIDE the github one, which is the
// alias twin this tier exists for. The twin is not an artefact of the flag —
// grype matches by CPE for java, go binaries and OS packages by default, so a
// production scan of those ecosystems produces exactly this shape. The flag
// only makes it reproducible in a python fixture.
const pythonGrype = read('python/requirements-grype.json');
const npmGrype = read('jquery-grype.json');

describe('V0 — alias dedup', () => {
  it('collapses the nvd and github reports of one vulnerability into one row', () => {
    // CAPTURED: pyyaml 5.3.1 comes back as BOTH `CVE-2020-14343` (nvd:cpe) and
    // `GHSA-8q59-q68h-6hv4` (github:language:python). Two rows for one problem
    // is how a triage list becomes twice as long as the work in it.
    const raw = JSON.parse(pythonGrype) as { matches: { vulnerability: { id: string } }[] };
    const ids = raw.matches.map((m) => m.vulnerability.id);
    expect(ids).toContain('CVE-2020-14343');
    expect(ids).toContain('GHSA-8q59-q68h-6hv4');

    const { matches, funnel } = parseGrypeMatches(pythonGrype);
    const { groups, collapsed } = dedupeByAlias(matches);

    const pyyaml = groups.filter((g) => g.match.packageName === 'pyyaml');
    expect(pyyaml).toHaveLength(1);
    expect(pyyaml[0]!.primaryId).toBe('CVE-2020-14343');
    expect(pyyaml[0]!.aliases).toContain('GHSA-8q59-q68h-6hv4');

    // The 17 raw matches were 11 vulnerabilities: 6 of them arrived twice.
    expect(funnel.rawMatches).toBe(17);
    expect(funnel.duplicatesCollapsed).toBe(6);
    expect(groups.length + collapsed).toBe(matches.length);
  });

  it('merges a GHSA-only record with a CVE record that names it', () => {
    // DERIVED from the capture above, and labelled as derived: the two records
    // below carry real ids in the real field shapes, with the github record's
    // relatedVulnerabilities REMOVED. That is the case W8-06's (purl, CVE) key
    // cannot join — the GHSA record has no CVE to key on — and it is why this
    // tier keys on the alias SET instead. Deriving it is honest here because
    // the shape is the captured one; only the linkage was weakened.
    const base = parseGrypeMatches(pythonGrype).matches.find((m) => m.packageName === 'pyyaml')!;
    const ghsaOnly: DependencyMatch = {
      ...base,
      vulnerabilityId: 'GHSA-8q59-q68h-6hv4',
      ids: ['GHSA-8q59-q68h-6hv4'],
      cveId: null,
      severity: 3,
      kev: false,
      // github advisories match on package identity; the nvd record below
      // matches on a CPE guess. Both are the real match types for their
      // namespace in the capture.
      matchType: 'exact-direct-match',
    };
    const cveOnly: DependencyMatch = {
      ...base,
      vulnerabilityId: 'CVE-2020-14343',
      ids: ['CVE-2020-14343', 'GHSA-8q59-q68h-6hv4'],
      cveId: 'CVE-2020-14343',
      severity: 5,
      matchType: 'cpe-match',
    };

    const { groups, collapsed } = dedupeByAlias([ghsaOnly, cveOnly]);
    expect(groups).toHaveLength(1);
    expect(collapsed).toBe(1);
    expect(groups[0]!.primaryId).toBe('CVE-2020-14343');
    expect(groups[0]!.aliases).toEqual(['GHSA-8q59-q68h-6hv4']);
    // The WORSE severity survives the merge. Taking whichever record arrived
    // first would make a critical finding medium on a day the database was
    // walked in a different order.
    expect(groups[0]!.match.severity).toBe(5);
    // And the merged row is a COMPOSITE on purpose: the strongest true claim on
    // each axis, even when severity and match type come from different records.
    // Both providers are right about the same vulnerability.
    expect(groups[0]!.match.matchType).toMatch(/^exact-/);
  });

  it('keeps one CVE against two packages as two findings', () => {
    // Two things to upgrade is two findings. Merging on the vulnerability
    // alone would hide one package behind the other.
    const base = parseGrypeMatches(pythonGrype).matches[0]!;
    const { groups } = dedupeByAlias([
      base,
      { ...base, packageName: 'other', purl: 'pkg:pypi/other@1.0.0' },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('V1 — dependency scoping against the lockfile', () => {
  const resolved = readResolvedSet(path.join(FIXTURES, 'vulnerable'));

  it('reads dev, direct and transitive out of the npm lockfile', () => {
    // THE DEPTH RAMP FIRES HERE, and it does not from the SBOM: syft's
    // CycloneDX root is the scanned directory and its bom-ref is absent from
    // `dependencies[]`, so resolveScopes returns depth 1 for everything (pinned
    // in W8-06's own test). The lockfile has the real graph — root -> debug ->
    // ms — and §3.6 names the lockfile as this tier's mechanism.
    expect(scopeFor(resolved, 'npm', 'jquery', '3.4.1').scope).toEqual({
      kind: 'prod-direct',
      depth: 1,
    });
    expect(scopeFor(resolved, 'npm', 'ms', '2.1.2').scope).toEqual({
      kind: 'prod-transitive',
      depth: 2,
    });
    // Hoisting is why this is a graph walk and not a path-segment count: `ms`
    // lives at the TOP-LEVEL path `node_modules/ms` and is still transitive.
    expect(scopeFor(resolved, 'npm', 'minimist', '1.2.0').scope).toEqual({
      kind: 'dev',
      depth: 1,
    });
  });

  it('never dismisses a dev dependency, only prices it lower', () => {
    // Build-time supply chain is how a package steals a publish token. A funnel
    // that hid dev findings would hide the class of attack that keeps happening.
    const dev = scopeFor(resolved, 'npm', 'minimist', '1.2.0');
    expect(dev.inResolvedSet).toBe(true);
    const priced = priceFinding({
      dimension: 'dependency',
      severity: 4,
      confidence: 5,
      epss: 0.5,
      depScope: { kind: 'dev', depth: 1 },
      reachability: 'manifest_only',
    });
    const shipped = priceFinding({
      dimension: 'dependency',
      severity: 4,
      confidence: 5,
      epss: 0.5,
      depScope: { kind: 'prod-direct', depth: 1 },
      reachability: 'manifest_only',
    });
    expect(priced.effectiveRisk).toBeGreaterThan(0);
    expect(priced.effectiveRisk).toBeLessThan(shipped.effectiveRisk);
  });

  it('reports a package no lockfile resolves, and proposes component_not_present', () => {
    const absent = scopeFor(resolved, 'npm', 'left-pad', '1.3.0');
    expect(absent.inResolvedSet).toBe(false);
    expect(absent.unreadableReason).toBeNull();
  });

  it('tells a version disagreement from a missing version', () => {
    // The SBOM says 3.4.1 and the lockfile says 3.4.1 — agreement. A different
    // version is a real disagreement about what ships and is reported as one;
    // a manifest that pins NOTHING is the manifest declining to say, which is
    // not a mismatch.
    expect(scopeFor(resolved, 'npm', 'jquery', '3.4.1').versionMatches).toBe(true);
    expect(scopeFor(resolved, 'npm', 'jquery', '3.5.0').versionMatches).toBe(false);

    const unpinned = readResolvedSet(writeTemp('requirements.txt', 'flask\n'));
    expect(scopeFor(unpinned, 'python', 'flask', '2.0.0').versionMatches).toBe(true);
  });

  it('reads go.mod, with // indirect as the transitive marker', () => {
    const go = readResolvedSet(path.join(FIXTURES, 'go-unreachable'));
    expect(
      scopeFor(go, 'go-module', 'github.com/dgrijalva/jwt-go', 'v3.2.0+incompatible'),
    ).toMatchObject({
      inResolvedSet: true,
      versionMatches: true,
      scope: { kind: 'prod-direct', depth: 1 },
    });
  });

  it('normalizes pypi names the way PEP 503 does', () => {
    const py = readResolvedSet(path.join(FIXTURES, 'python'));
    // The manifest says `pyyaml`; grype's artifact is `pyyaml`; a repository
    // writing `PyYAML` means the same project. Comparing raw strings would
    // report a package that is present as absent, which is the direction that
    // proposes not_affected on something real.
    expect(scopeFor(py, 'python', 'PyYAML', '5.3.1').inResolvedSet).toBe(true);

    // The separator half of the rule: runs of `-`, `_` and `.` all collapse to
    // one `-`, so these four spellings are one project. They are NOT the same
    // as inserting a separator that is not there — `py_yaml` is a different
    // name from `pyyaml`, and this reader treats it as one.
    const dateutil = readResolvedSet(writeTemp('requirements.txt', 'python-dateutil==2.8.2\n'));
    for (const spelling of ['python_dateutil', 'Python.DateUtil', 'python--dateutil']) {
      expect(scopeFor(dateutil, 'python', spelling, '2.8.2').inResolvedSet).toBe(true);
    }
    expect(scopeFor(py, 'python', 'py_yaml', '5.3.1').inResolvedSet).toBe(false);
  });

  it('says "no reader" rather than "not present" for an ecosystem it cannot parse', () => {
    // A maven finding is not absent from the tree; it is an ecosystem this
    // reader has no parser for. Reporting the two the same way would propose
    // component_not_present on a real dependency of a Java repository.
    const maven = scopeFor(resolved, 'java-archive', 'log4j-core', '2.14.1');
    expect(maven.inResolvedSet).toBe(false);
    expect(maven.unreadableReason).toMatch(/no manifest reader/);
  });
});

describe('V2 — usage detection', () => {
  const imports = scanImports(path.join(FIXTURES, 'vulnerable'));
  const resolved = readResolvedSet(path.join(FIXTURES, 'vulnerable'));
  const usage = (name: string) =>
    usageFor(imports, 'npm', name, scopeFor(resolved, 'npm', name, '').scope);

  it('finds a require() with the file and line to prove it', () => {
    const jquery = usage('jquery');
    expect(jquery.status).toBe('imported');
    expect(jquery.evidence[0]).toMatchObject({ file: path.join('src', 'index.js') });
    expect(jquery.evidence[0]!.line).toBeGreaterThan(0);
    expect(jquery.evidence[0]!.quote).toMatch(/require\('jquery'\)/);
  });

  it('reports a direct npm dependency nothing imports as not_imported', () => {
    // npm is the ecosystem where absence is informative: the import specifier
    // IS the package name, by the resolution algorithm.
    expect(usage('debug').status).toBe('not_imported');
  });

  it('answers UNKNOWN for a transitive dependency rather than not_imported', () => {
    // `ms` is reached through `debug` and this repository was never expected to
    // name it. Calling that "not imported" would propose not_affected on a
    // fully reachable vulnerability — the one direction that is unsafe.
    const ms = usage('ms');
    expect(ms.status).toBe('unknown');
    expect(ms.unknownReason).toMatch(/transitive/);
  });

  it('answers UNKNOWN for a pypi package it cannot find', () => {
    // pyyaml is `import yaml`, beautifulsoup4 is `bs4`, pillow is `PIL`. The
    // mapping lives in installed distribution metadata, which a source tarball
    // does not carry, so absence proves nothing here.
    const py = scanImports(path.join(FIXTURES, 'python'));
    const pyResolved = readResolvedSet(path.join(FIXTURES, 'python'));
    expect(
      usageFor(
        py,
        'pypi',
        'requests',
        pyResolved.entries.size ? { kind: 'prod-direct', depth: 1 } : null,
      ).status,
    ).toBe('imported');
    const jinja = usageFor(py, 'pypi', 'jinja2', { kind: 'prod-direct', depth: 1 });
    expect(jinja.status).toBe('unknown');
    expect(jinja.unknownReason).toMatch(/different name/);
  });

  it('does not count a relative import as a package', () => {
    // './helpers' is not a dependency. Counting it would make every repository
    // look like it imported everything.
    const npm = imports.byEcosystem.get('npm')!;
    expect([...npm.keys()]).toContain('jquery');
    expect([...npm.keys()].some((k) => k.startsWith('.'))).toBe(false);
  });

  it('matches a Go import path against the module it belongs to', () => {
    const go = scanImports(path.join(FIXTURES, 'go-reachable'));
    const verdict = usageFor(go, 'go', 'github.com/dgrijalva/jwt-go', {
      kind: 'prod-direct',
      depth: 1,
    });
    expect(verdict.status).toBe('imported');
  });
});

describe('V3 — symbol reachability (govulncheck, source mode)', () => {
  // CAPTURED:
  //   cd fixtures/dependency/go-reachable && GOFLAGS=-mod=vendor GOPROXY=off \
  //     govulncheck -db file://…/fixtures/dependency/go-vulndb -format json ./...
  // and the same command in go-unreachable. Both ran OFFLINE, which is what
  // makes the tier possible under --network=none at all.
  const reachable = read('go-reachable/govulncheck.json');
  const unreachable = read('go-unreachable/govulncheck.json');

  it('proves a call path, with the caller file and line', () => {
    const parsed = parseGovulncheck(reachable);
    expect(parsed.scannerVersion).toBe('v1.7.0');
    const vuln = parsed.vulnerabilities.find((v) => v.osvId === 'GO-2020-0017')!;
    expect(vuln.symbolReachable).toBe(true);
    expect(vuln.aliases).toContain('CVE-2020-26160');
    expect(vuln.callSites[0]).toMatchObject({
      file: 'main.go',
      line: 11,
      symbol: 'MapClaims.VerifyAudience',
    });
  });

  it('proves UNREACHABLE from module-level findings with no function frame', () => {
    // The same module, the same version, the same advisory — and no call. Every
    // affected module produces a module-level finding and every loaded package
    // a package-level one, so the presence of findings says nothing; only a
    // frame naming a FUNCTION means the call graph has a path in.
    const parsed = parseGovulncheck(unreachable);
    const vuln = parsed.vulnerabilities.find((v) => v.osvId === 'GO-2020-0017')!;
    expect(vuln.symbolReachable).toBe(false);
    expect(vuln.callSites).toEqual([]);
    expect(reachabilityFor('imported', vuln, null).tier).toBe('proven_unreachable');
  });

  it('never returns proven_unreachable without a proof', () => {
    // 'not imported' is V2's much weaker claim and must not be promoted into a
    // proof. Only a call-graph tool that looked and found nothing may say this.
    expect(reachabilityFor('not_imported', null, 'no prover').tier).toBe('manifest_only');
    expect(reachabilityFor('imported', null, 'no prover').tier).toBe('imported');
    expect(reachabilityFor('unknown', null, 'no prover').unavailableReason).toBe('no prover');
  });

  it('refuses to run without a Go vulnerability database, and says why', async () => {
    // govulncheck with no database reports no vulnerabilities, and "nothing is
    // reachable" is precisely the answer that would let a real one through.
    const missing = checkGoVulnDb(path.join(tmpdir(), 'w8-13-no-go-db'));
    expect(missing.ok).toBe(false);

    const result = await goReachability({
      targetDir: path.join(FIXTURES, 'go-reachable'),
      image: 'localhost/repopulse/scan:test',
      goVulnDb: path.join(tmpdir(), 'w8-13-no-go-db'),
      budget: { wallClockMs: 5_000 },
      spawnFn: (() => {
        throw new Error('a container must not start without a database');
      }) as never,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/no Go vulnerability database/);
  });

  it('skips a module that is not vendored, because source mode needs the network', async () => {
    const notVendored = writeTemp('go.mod', 'module example.com/x\n\ngo 1.22\n');
    const result = await goReachability({
      targetDir: notVendored,
      image: 'localhost/repopulse/scan:test',
      goVulnDb: path.join(FIXTURES, 'go-vulndb'),
      budget: { wallClockMs: 5_000 },
      spawnFn: (() => {
        throw new Error('a container must not start for an unresolvable module');
      }) as never,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/not vendored/);
  });

  it('mounts the database read-only and keeps the profile unmodified', async () => {
    // NFR-14 is not negotiable and this tier does not get an exception: the
    // argv below is buildSandboxArgs' own, and the only thing V3 adds to it is
    // one more ro,noexec mount.
    let argv: string[] = [];
    const result = await goReachability({
      targetDir: path.join(FIXTURES, 'go-reachable'),
      image: 'localhost/repopulse/scan:test',
      goVulnDb: path.join(FIXTURES, 'go-vulndb'),
      budget: { wallClockMs: 20_000 },
      spawnFn: ((_cmd: string, args: string[], opts: object) => {
        argv = args;
        return spawn(
          process.execPath,
          ['-e', `process.stdout.write(${JSON.stringify(reachable)})`],
          opts,
        );
      }) as never,
    });

    expect(argv).toContain('--network=none');
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--user=65534:65534');
    expect(argv.some((a) => a.startsWith('--volume=') && a.endsWith('/go-vulndb:ro,noexec'))).toBe(
      true,
    );
    // Offline flags, because govulncheck reaches for vuln.go.dev and the module
    // proxy by default and a tool that degrades silently is worse than one that
    // fails.
    const command = argv[argv.length - 1]!;
    expect(command).toContain('GOPROXY=off');
    expect(command).toContain('-mod=vendor');
    expect(command).toContain('-db file:///go-vulndb');

    expect(result.status).toBe('succeeded');
    expect(result.vulnerabilities[0]?.symbolReachable).toBe(true);
  });
});

describe('V4 and the funnel end to end', () => {
  const validation = validateVulnerabilities({
    matches: parseGrypeMatches(npmGrype).matches,
    snapshotDir: path.join(FIXTURES, 'vulnerable'),
    goReachability: null,
  });

  it("reports every tier's counts, and dismisses nothing", () => {
    // THE HONESTY RULE (FR-SEC-15). raw -> deduped is a narrowing; everything
    // after it is a breakdown of the SAME population, and the two are reported
    // differently on purpose. Nothing in this ticket may dismiss a finding —
    // that needs a human and a VEX justification (W8-14).
    const { funnel } = validation;
    expect(funnel.raw).toBe(2);
    expect(funnel.deduped).toBe(2);
    expect(funnel.dismissed).toBe(0);
    // raw NARROWS to deduped and never the other way: V0 can only merge rows.
    expect(funnel.deduped).toBeLessThanOrEqual(funnel.raw);

    const scoped =
      funnel.scoped.prodDirect +
      funnel.scoped.prodTransitive +
      funnel.scoped.dev +
      funnel.scoped.notInResolvedSet +
      funnel.scoped.unreadable;
    expect(scoped).toBe(funnel.deduped);
    expect(funnel.usage.imported + funnel.usage.notImported + funnel.usage.unknown).toBe(
      funnel.deduped,
    );
    const reach = funnel.reachability;
    expect(
      reach.symbolReachable + reach.provenUnreachable + reach.imported + reach.manifestOnly,
    ).toBe(funnel.deduped);
  });

  it('prices through priceFinding, feeding it EPSS, KEV, scope and reachability', () => {
    // ONE scoring path. priceFinding is imported rather than reimplemented,
    // because two ways of computing one number is how the UI popover stops
    // matching the score it claims to explain.
    const { priced } = dependencyFindings(
      validation.vulnerabilities,
      JSON.parse(read('jquery-sbom.cyclonedx.json')) as Record<string, unknown>,
    );
    const kev = priced.find((p) => p.finding.cveId === 'CVE-2020-11023')!;
    expect(kev.pricing.band).toBe('act');
    expect(kev.pricing.riskFactors.inputs['kev']).toBe(true);
    expect(kev.pricing.riskFactors.inputs['epss']).toBeTypeOf('number');
    expect(kev.pricing.riskFactors.inputs['reachability']).toBe('imported');
    expect(kev.pricing.riskFactors.inputs['dep_scope']).toEqual({
      kind: 'prod-direct',
      depth: 1,
    });
    // The stored decomposition reproduces the stored score, which is the whole
    // basis of the "recompute from what you were served" check.
    expect(
      Math.round(
        100 *
          kev.pricing.riskFactors.H *
          kev.pricing.riskFactors.L *
          kev.pricing.riskFactors.X *
          100,
      ) / 100,
    ).toBe(kev.pricing.effectiveRisk);
  });

  it('ranks a proven-unreachable finding below an imported one', () => {
    // The point of V3: the same CVE, on the same package, priced by what was
    // proven about it.
    const inputs = {
      dimension: 'dependency' as const,
      severity: 4,
      confidence: 5,
      epss: 0.5,
      depScope: { kind: 'prod-direct' as const, depth: 1 },
    };
    const proven = priceFinding({ ...inputs, reachability: 'proven_unreachable' });
    const imported = priceFinding({ ...inputs, reachability: 'imported' });
    const symbol = priceFinding({ ...inputs, reachability: 'symbol_reachable' });
    expect(proven.effectiveRisk).toBeLessThan(imported.effectiveRisk);
    expect(imported.effectiveRisk).toBeLessThan(symbol.effectiveRisk);
    // And it is NOT zero. A downgraded finding is still on the list; only a
    // human with a VEX justification takes one off it.
    expect(proven.effectiveRisk).toBeGreaterThan(0);
  });

  it('PINS the reprice divergence this ticket could not fix', () => {
    // repriceFindings (packages/insights/src/risk/reprice.ts) builds its
    // PricingInput from `kev` and `dep_scope` ONLY — it passes neither `epss`
    // nor `reachability`, both of which this scanner now writes. So the nightly
    // job re-prices these findings at the likelihood FLOOR and flattens the
    // reachability factor back to manifest_only.
    //
    // That file is outside this ticket's write scope. The gap is asserted
    // rather than described, so the day someone adds the two lines, this test
    // fails and tells them the scanner already had the data.
    const asScannerPrices = priceFinding({
      dimension: 'dependency',
      severity: 4,
      confidence: 5,
      epss: 0.8,
      kev: false,
      depScope: { kind: 'prod-direct', depth: 1 },
      reachability: 'proven_unreachable',
    });
    const asRepriceWouldPrice = priceFinding({
      dimension: 'dependency',
      severity: 4,
      confidence: 5,
      kev: false,
      depScope: { kind: 'prod-direct', depth: 1 },
    });
    expect(asScannerPrices.effectiveRisk).not.toBe(asRepriceWouldPrice.effectiveRisk);
  });

  it('proposes a VEX justification for a never-imported dependency, and only proposes', () => {
    const debug = validation.vulnerabilities.find((v) => v.packageName === 'debug');
    const jquery = validation.vulnerabilities.find((v) => v.packageName === 'jquery')!;
    expect(jquery.proposals).toEqual([]);

    // The fixture's only vulnerable packages are jquery's two CVEs, so the
    // not-imported PROPOSAL is exercised on the tier's own output rather than
    // on a finding that does not exist here.
    expect(debug).toBeUndefined();
    const proposal = validateVulnerabilities({
      matches: [
        {
          ...parseGrypeMatches(npmGrype).matches[0]!,
          packageName: 'debug',
          packageVersion: '4.3.4',
          purl: 'pkg:npm/debug@4.3.4',
        },
      ],
      snapshotDir: path.join(FIXTURES, 'vulnerable'),
      goReachability: null,
    });
    expect(proposal.vulnerabilities[0]!.usage.status).toBe('not_imported');
    expect(proposal.vulnerabilities[0]!.proposals[0]!.justification).toBe(
      'vulnerable_code_not_in_execute_path',
    );
    // THE WORDING IS THE POINT. "not imported" must never read as "not
    // exploitable": the sentence a reviewer sees has to name what the check
    // cannot see.
    expect(proposal.vulnerabilities[0]!.proposals[0]!.statement).toMatch(
      /not proof the code cannot run/,
    );
    expect(proposal.funnel.dismissed).toBe(0);
    expect(proposal.funnel.proposed['vulnerable_code_not_in_execute_path']).toBe(1);
  });

  it('joins a govulncheck proof to a grype match by alias and module', () => {
    // The two tools do not share an id space: grype says CVE-2020-26160,
    // govulncheck says GO-2020-0017. The join is the advisory's alias list, and
    // the module check stops one advisory's proof being borrowed by a different
    // package it also affects (jwt-go and jwt-go/v4 are one GO id, two modules).
    const base = parseGrypeMatches(npmGrype).matches[0]!;
    const result = validateVulnerabilities({
      matches: [
        {
          ...base,
          vulnerabilityId: 'GHSA-w73w-5m7g-f7qc',
          ids: ['CVE-2020-26160', 'GHSA-W73W-5M7G-F7QC'],
          cveId: 'CVE-2020-26160',
          packageType: 'go-module',
          packageName: 'github.com/dgrijalva/jwt-go',
          packageVersion: 'v3.2.0+incompatible',
          purl: 'pkg:golang/github.com/dgrijalva/jwt-go@v3.2.0+incompatible',
        },
      ],
      snapshotDir: path.join(FIXTURES, 'go-unreachable'),
      goReachability: {
        status: 'succeeded',
        vulnerabilities: parseGovulncheck(read('go-unreachable/govulncheck.json')).vulnerabilities,
        toolVersion: 'v1.7.0',
        reason: null,
      },
    });

    const vuln = result.vulnerabilities[0]!;
    expect(vuln.reachability.tier).toBe('proven_unreachable');
    expect(vuln.reachability.provenBy).toBe('govulncheck');
    expect(vuln.scope.scope).toEqual({ kind: 'prod-direct', depth: 1 });
    expect(vuln.proposals[0]!.justification).toBe('vulnerable_code_not_in_execute_path');
    expect(result.funnel.reachability.provenUnreachable).toBe(1);
  });

  it('sweeps only the manifests the SBOM located a component in', () => {
    // persistFindings auto-resolves any open dependency finding whose file is
    // in reviewedFiles. V1's walker finds requirements.txt and go.mod whether
    // or not syft catalogued anything from them, so widening this list with V1's
    // manifests would let a run that catalogued NOTHING for an ecosystem close
    // every open finding in it — a scanner that did not run marking live CVEs
    // fixed. Pinned so the widening cannot come back by accident.
    const { reviewedFiles } = dependencyFindings(
      validation.vulnerabilities,
      JSON.parse(read('jquery-sbom.cyclonedx.json')) as Record<string, unknown>,
    );
    expect(reviewedFiles).toEqual(['package-lock.json']);
    // V1 read that same lockfile, and reports it — informing without closing.
    expect(validation.manifests).toContain('package-lock.json');
  });

  it('says WHY V3 was silent for an ecosystem with no prover', () => {
    // Silence read as proof is the failure mode. JS/TS and Python have no
    // equivalent of govulncheck here, and the verdict carries that sentence.
    const jquery = validation.vulnerabilities[0]!;
    expect(jquery.reachability.provenBy).toBeNull();
    expect(jquery.reachability.unavailableReason).toMatch(/govulncheck is Go-only/);
  });
});

/** A one-file scratch tree, for the manifest shapes no fixture should carry. */
function writeTemp(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'w8-13-'));
  writeFileSync(path.join(dir, name), contents);
  return dir;
}
