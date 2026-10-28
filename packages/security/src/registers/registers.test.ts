import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readComponents, resolveScopes, parsePurl } from './sbom.js';
import { policyFrom } from './run.js';
import {
  dependencyHealthFindings,
  libyearFor,
  majorOf,
  type ReleaseFactsRow,
} from './dependency-health.js';
import { cycleFor, dockerfileRuntimes, eolFindings, manifestRuntimes } from './eol.js';
import {
  licenseFindings,
  licenseIds,
  uncheckedLicenseCount,
  DEFAULT_LICENSE_POLICY,
} from './license.js';
import { readDeclaredRuntimes } from './manifests.js';

// Supply-chain registers (W10-02, FR-REG-2/3/4).

const NOW = new Date('2026-08-19T00:00:00Z');

function sbom(components: unknown[], dependencies?: unknown[]): Record<string, unknown> {
  return {
    bomFormat: 'CycloneDX',
    metadata: { component: { 'bom-ref': 'root', name: 'app' } },
    components,
    ...(dependencies ? { dependencies } : {}),
  };
}

const meta = (over: Partial<ReleaseFactsRow>): ReleaseFactsRow => ({
  ecosystem: 'npm',
  package: 'left-pad',
  latestVersion: '1.3.0',
  latestReleaseAt: new Date('2026-08-01T00:00:00Z'),
  deprecated: false,
  yanked: null,
  versionDates: {},
  ...over,
});

describe('reading a CycloneDX document', () => {
  it('takes the ecosystem from the purl and ignores components without one', () => {
    const components = readComponents(
      sbom([
        { name: 'left-pad', version: '1.0.0', purl: 'pkg:npm/left-pad@1.0.0' },
        { name: 'requests', version: '2.0.0', purl: 'pkg:pypi/requests@2.0.0' },
        { name: 'libfoo', version: '1', purl: 'pkg:deb/debian/libfoo@1' },
        { name: 'no-purl', version: '1' },
      ]),
    );
    expect(components.map((c) => `${c.ecosystem}:${c.name}`)).toEqual([
      'npm:left-pad',
      'pypi:requests',
    ]);
  });

  it('reads both license shapes CycloneDX allows', () => {
    const components = readComponents(
      sbom([
        { purl: 'pkg:npm/a@1', licenses: [{ license: { id: 'MIT' } }] },
        { purl: 'pkg:npm/b@1', licenses: [{ expression: 'MIT OR Apache-2.0' }] },
        { purl: 'pkg:npm/c@1' },
      ]),
    );
    expect(components.map((c) => c.license)).toEqual(['MIT', 'MIT OR Apache-2.0', null]);
  });

  it('reads dev-ness from BOTH places real generators put it', () => {
    const components = readComponents(
      sbom([
        { purl: 'pkg:npm/a@1', scope: 'excluded' },
        {
          purl: 'pkg:npm/b@1',
          properties: [{ name: 'cdx:npm:package:development', value: 'true' }],
        },
        { purl: 'pkg:npm/c@1' },
      ]),
    );
    expect(components.map((c) => c.dev)).toEqual([true, true, false]);
  });

  it('scopes by graph depth, and depth is hops from the root', () => {
    const resolved = resolveScopes(
      sbom(
        [
          { 'bom-ref': 'a', purl: 'pkg:npm/a@1' },
          { 'bom-ref': 'b', purl: 'pkg:npm/b@1' },
          { 'bom-ref': 'c', purl: 'pkg:npm/c@1' },
        ],
        [
          { ref: 'root', dependsOn: ['a'] },
          { ref: 'a', dependsOn: ['b'] },
          { ref: 'b', dependsOn: ['c'] },
        ],
      ),
    );
    expect(resolved.map((c) => [c.name, c.scope, c.depth])).toEqual([
      ['a', 'prod-direct', 1],
      ['b', 'prod-transitive', 2],
      ['c', 'prod-transitive', 3],
    ]);
  });

  it('treats a graph-less document as all-direct rather than guessing deep', () => {
    // Over-stating exposure keeps a finding visible; under-stating it buries
    // one. When we do not know, we fail in the loud direction.
    const resolved = resolveScopes(sbom([{ purl: 'pkg:npm/a@1' }]));
    expect(resolved[0]!.scope).toBe('prod-direct');
  });

  it('parses a purl with qualifiers', () => {
    expect(parsePurl('pkg:npm/%40scope%2Fpkg@1.0.0?arch=x64')).toEqual({
      ecosystem: 'npm',
      name: '@scope/pkg',
      version: '1.0.0',
    });
  });
});

describe('dependency health', () => {
  const component = (over: Record<string, unknown> = {}) =>
    resolveScopes(sbom([{ purl: 'pkg:npm/left-pad@1.0.0', ...over }]));

  it('reports abandonment from the newest release date', () => {
    const { findings } = dependencyHealthFindings({
      components: component(),
      releaseMeta: [meta({ latestReleaseAt: new Date('2023-01-01T00:00:00Z') })],
      now: NOW,
    });
    expect(findings.map((f) => f.signal)).toContain('abandoned');
    expect(findings.find((f) => f.signal === 'abandoned')!.severity).toBe(3);
  });

  it('ranks the same abandonment lower when it is dev-scoped', () => {
    const { findings } = dependencyHealthFindings({
      components: component({ scope: 'excluded' }),
      releaseMeta: [meta({ latestReleaseAt: new Date('2023-01-01T00:00:00Z') })],
      now: NOW,
    });
    const abandoned = findings.find((f) => f.signal === 'abandoned')!;
    expect(abandoned.scope).toBe('dev');
    expect(abandoned.severity).toBe(2);
  });

  it('flags deprecated and yanked separately, at different severities', () => {
    const { findings } = dependencyHealthFindings({
      components: component(),
      releaseMeta: [meta({ deprecated: true, yanked: true })],
      now: NOW,
    });
    expect(findings.find((f) => f.signal === 'yanked')!.severity).toBe(4);
    expect(findings.find((f) => f.signal === 'deprecated')!.severity).toBe(3);
  });

  it('ramps major-version lag: two majors behind outranks one', () => {
    const one = dependencyHealthFindings({
      components: component(),
      releaseMeta: [meta({ latestVersion: '2.0.0' })],
      now: NOW,
    }).findings.find((f) => f.signal === 'major_lag')!;
    const two = dependencyHealthFindings({
      components: component(),
      releaseMeta: [meta({ latestVersion: '3.0.0' })],
      now: NOW,
    }).findings.find((f) => f.signal === 'major_lag')!;
    expect(one.severity).toBe(2);
    expect(two.severity).toBe(3);
  });

  it('computes libyear from the INSTALLED release date, not the age of latest', () => {
    const { findings, repoLibyear } = dependencyHealthFindings({
      components: component(),
      releaseMeta: [
        meta({
          latestReleaseAt: new Date('2026-08-01T00:00:00Z'),
          versionDates: { '1.0.0': '2022-08-01T00:00:00Z' },
        }),
      ],
      now: NOW,
    });
    expect(repoLibyear).toBeCloseTo(4, 1);
    expect(findings.find((f) => f.signal === 'libyear')).toBeTruthy();
  });

  it('leaves libyear NULL when the installed version has no date', () => {
    // null, not 0: unmeasured is not "perfectly current" — the conflation this
    // codebase keeps having to undo.
    expect(libyearFor(null, new Date())).toBeNull();
    const { repoLibyear } = dependencyHealthFindings({
      components: component(),
      releaseMeta: [meta({})],
      now: NOW,
    });
    expect(repoLibyear).toBeNull();
  });

  it('REPORTS the components it could not measure', () => {
    const result = dependencyHealthFindings({
      components: resolveScopes(
        sbom([{ purl: 'pkg:npm/left-pad@1.0.0' }, { purl: 'pkg:npm/unknown-pkg@1.0.0' }]),
      ),
      releaseMeta: [meta({})],
      now: NOW,
    });
    expect(result.measured).toBe(1);
    expect(result.unmeasured).toBe(1);
  });

  it('reads a major out of a version, and null out of a non-numeric one', () => {
    expect(majorOf('v12.4.1')).toBe(12);
    expect(majorOf('latest')).toBeNull();
  });
});

describe('EOL', () => {
  const cycles = [
    {
      product: 'nodejs',
      cycle: '18',
      eolDate: new Date('2025-04-30'),
      supportUntil: null,
      latestVersion: '18.20.0',
    },
    {
      product: 'nodejs',
      cycle: '20',
      eolDate: new Date('2026-04-30'),
      supportUntil: null,
      latestVersion: '20.19.0',
    },
    {
      product: 'nodejs',
      cycle: '22',
      eolDate: new Date('2027-04-30'),
      supportUntil: null,
      latestVersion: '22.11.0',
    },
    {
      product: 'python',
      cycle: '3.1',
      eolDate: new Date('2012-01-01'),
      supportUntil: null,
      latestVersion: '3.1.5',
    },
    {
      product: 'python',
      cycle: '3.11',
      eolDate: new Date('2026-10-31'),
      supportUntil: null,
      latestVersion: '3.11.9',
    },
  ];

  it('matches the LONGEST cycle prefix, not the first one that starts alike', () => {
    // '3.11' must not match cycle '3.1' — that would report a 2012 EOL date
    // for a runtime that is supported until late 2026.
    expect(
      cycleFor(
        '3.11.4',
        cycles.filter((c) => c.product === 'python'),
      )!.cycle,
    ).toBe('3.11');
  });

  it('sev 4 for a past-EOL production runtime', () => {
    const { findings } = eolFindings({
      declared: [{ product: 'node', version: '18.20.0', file: 'Dockerfile' }],
      cycles,
      now: NOW,
    });
    expect(findings[0]!.severity).toBe(4);
    expect(findings[0]!.ruleId).toBe('eol.past');
  });

  it('sev 2 inside the 90-day window, and silence outside it', () => {
    const soon = eolFindings({
      declared: [{ product: 'nodejs', version: '22', file: '.nvmrc' }],
      cycles,
      now: new Date('2027-03-01T00:00:00Z'),
    });
    expect(soon.findings[0]!.severity).toBe(2);

    const later = eolFindings({
      declared: [{ product: 'nodejs', version: '22', file: '.nvmrc' }],
      cycles,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(later.findings).toEqual([]);
  });

  it('says NOTHING about a product it has no data for, and counts it', () => {
    const result = eolFindings({
      declared: [{ product: 'erlang', version: '26', file: 'Dockerfile' }],
      cycles,
      now: NOW,
    });
    expect(result.findings).toEqual([]);
    expect(result.unknown).toEqual([{ product: 'erlang', version: '26', reason: 'no_product' }]);
  });

  it('names endoflife.date as the source of the date it quotes', () => {
    const { findings } = eolFindings({
      declared: [{ product: 'node', version: '18', file: 'Dockerfile' }],
      cycles,
      now: NOW,
    });
    expect(findings[0]!.evidence).toContain('2025-04-30');
  });

  it('reads base images out of a Dockerfile, tag suffix and all', () => {
    const declared = dockerfileRuntimes(
      'Dockerfile',
      'FROM node:20-alpine AS build\nRUN echo hi\nFROM --platform=linux/amd64 python:3.11-slim\nFROM scratch\nFROM redis:latest\n',
    );
    expect(declared.map((d) => `${d.product}:${d.version}`)).toEqual(['node:20', 'python:3.11']);
  });

  it('reads engines, .nvmrc and requires-python out of manifests', () => {
    expect(manifestRuntimes('package.json', '{"engines":{"node":">=20"}}')).toEqual([
      { product: 'node', version: '>=20', file: 'package.json' },
    ]);
    expect(manifestRuntimes('.nvmrc', '20.11.0\n')[0]!.version).toBe('20.11.0');
    expect(manifestRuntimes('pyproject.toml', 'requires-python = ">=3.11"')[0]!.product).toBe(
      'python',
    );
  });

  it('says nothing about a package.json it cannot parse', () => {
    expect(manifestRuntimes('package.json', '{ not json')).toEqual([]);
  });

  it('walks a snapshot for manifests, skipping node_modules', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'w10-02-'));
    mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', 'x', 'package.json'),
      '{"engines":{"node":"14"}}',
    );
    writeFileSync(path.join(root, '.nvmrc'), '20\n');
    writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:18-bullseye\n');
    const { declared } = readDeclaredRuntimes(root);
    expect(declared.map((d) => `${d.file}:${d.version}`).sort()).toEqual([
      '.nvmrc:20',
      'Dockerfile:18',
    ]);
  });
});

describe('license posture', () => {
  const withLicense = (license: string | null, dev = false) =>
    resolveScopes(
      sbom([
        {
          purl: 'pkg:npm/some-lib@1.0.0',
          ...(license ? { licenses: [{ license: { id: license } }] } : {}),
          ...(dev ? { scope: 'excluded' } : {}),
        },
      ]),
    );

  it('flags AGPL in prod scope and stays silent on the same dep dev-scoped', () => {
    expect(licenseFindings(withLicense('AGPL-3.0')).map((f) => f.ruleId)).toEqual([
      'license.policy',
    ]);
    expect(licenseFindings(withLicense('AGPL-3.0', true))).toEqual([]);
  });

  it('does not flag a dual license the user may take permissively', () => {
    const policy = { ...DEFAULT_LICENSE_POLICY, allow: ['MIT'] };
    expect(licenseFindings(withLicense('MIT OR AGPL-3.0'), policy)).toEqual([]);
  });

  // Undeclared is only meaningful where the SBOM states licenses at all: one
  // sibling in the same ecosystem with a license proves the data was there.
  const undeclaredBesideStated = () =>
    resolveScopes(
      sbom([
        { purl: 'pkg:npm/some-lib@1.0.0' },
        { purl: 'pkg:npm/other-lib@1.0.0', licenses: [{ license: { id: 'MIT' } }] },
      ]),
    );

  it('flags an undeclared license, because unstated is not permissive', () => {
    const found = licenseFindings(undeclaredBesideStated());
    expect(found.map((f) => [f.ruleId, f.package])).toEqual([['license.unknown', 'some-lib']]);
  });

  // 2026-10-27 walkthrough: a yarn.lock-only SBOM states no license for any
  // package, and all 1,287 production npm dependencies of outline were
  // reported "undeclared", Apache-2.0 @aws-sdk packages among them.
  it('does not call a package undeclared where the SBOM carries no license data at all', () => {
    const blind = resolveScopes(
      sbom([{ purl: 'pkg:npm/some-lib@1.0.0' }, { purl: 'pkg:npm/other-lib@1.0.0' }]),
    );
    expect(licenseFindings(blind)).toEqual([]);
    expect(uncheckedLicenseCount(blind)).toBe(2);
    expect(uncheckedLicenseCount(undeclaredBesideStated())).toBe(0);
  });

  it('honours a policy that turns the unknown check off', () => {
    expect(
      licenseFindings(undeclaredBesideStated(), { ...DEFAULT_LICENSE_POLICY, flagUnknown: false }),
    ).toEqual([]);
  });

  it('splits an expression into ids', () => {
    expect(licenseIds('(MIT OR AGPL-3.0+) AND CC0-1.0')).toEqual(['MIT', 'AGPL-3.0', 'CC0-1.0']);
  });
});

describe('the sandbox did not move (FR-REG-2 acceptance)', () => {
  // W10-02 is the first code in this package that talks to the internet. The
  // thing that keeps that safe is that it runs in the WORKER lane and the scan
  // container still has no network at all — asserted here rather than assumed,
  // because the day someone "temporarily" drops the flag is the day a
  // third-party binary gets an egress path over a customer's source.
  const read = (relative: string): string =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), relative), 'utf8');

  it('still runs every scan container with --network=none', () => {
    expect(read('../../sandbox/profile.ts')).toContain('--network=none');
  });

  it('keeps the outbound fetch out of every scanner', () => {
    for (const file of [
      '../scanners/semgrep/scanner.ts',
      '../scanners/code-health/tools.ts',
      '../scanners/secrets/scanner.ts',
    ]) {
      const source = read(file);
      expect(source).not.toContain('sync/fetch-json');
      expect(source).not.toMatch(/\bfetch\(/);
    }
  });
});

describe('evidence identifies its subject', () => {
  // Two packages that happen to share a release date produced byte-identical
  // evidence, which collided on the findings dedup key and failed the whole
  // write. Evidence that does not name what it is about is also unreadable in
  // a report, so this is one bug with two symptoms.
  it('never emits two findings with the same evidence for different packages', () => {
    const components = resolveScopes(
      sbom([{ purl: 'pkg:npm/alpha@1.0.0' }, { purl: 'pkg:npm/beta@1.0.0' }]),
    );
    const { findings } = dependencyHealthFindings({
      components,
      releaseMeta: [
        meta({ package: 'alpha', latestReleaseAt: new Date('2021-01-01T00:00:00Z') }),
        meta({ package: 'beta', latestReleaseAt: new Date('2021-01-01T00:00:00Z') }),
      ],
      now: NOW,
    });
    const evidence = findings.map((f) => f.evidence);
    expect(new Set(evidence).size).toBe(evidence.length);
  });
});

// W20-08 (UX_TODO FND-18): Settings writes `license_policy` in snake case
// through the admin API; the register must apply it, and still honour a
// hand-written camel-case `licensePolicy` from before.
describe('policyFrom (W20-08)', () => {
  it('reads the snake-case policy Settings writes, defaulting each absent field', () => {
    const p = policyFrom({
      license_policy: { flag_categories: ['weak-copyleft', 'bogus'], flag_unknown: false },
    });
    expect(p.flagCategories).toEqual(['weak-copyleft']);
    expect(p.flagUnknown).toBe(false);
    expect(p.flag).toContain('AGPL-3.0');
    expect(p.allow).toEqual([]);
  });

  it('prefers the snake-case key and falls back to the legacy camel-case one', () => {
    expect(
      policyFrom({ license_policy: { flag: ['SSPL-1.0'] }, licensePolicy: { flag: ['GPL-3.0'] } })
        .flag,
    ).toEqual(['SSPL-1.0']);
    expect(policyFrom({ licensePolicy: { flagUnknown: false } }).flagUnknown).toBe(false);
  });
});
