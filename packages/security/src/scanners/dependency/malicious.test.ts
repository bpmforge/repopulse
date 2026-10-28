import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadMaliciousIndex,
  maliciousFinding,
  matchMalicious,
  compareSemver,
  packagesFromSbom,
  type MaliciousIndex,
} from './malicious.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILDER = path.resolve(HERE, '../../../../../deploy/build-malicious-index.py');

const index: MaliciousIndex = {
  generated: '2026-10-16T00:00:00Z',
  source: 'test',
  entries: {
    npm: {
      'evil-lib': [{ id: 'MAL-2024-1', summary: 'steals tokens', versions: null }],
      'half-bad': [{ id: 'MAL-2024-2', summary: 'one bad release', versions: ['1.0.1'] }],
    },
    PyPI: { colourama: [{ id: 'MAL-2024-3', summary: 'typosquat', versions: null }] },
  },
};

const sbom = {
  components: [
    { purl: 'pkg:npm/evil-lib@2.0.0', version: '2.0.0', properties: [{ name: 'syft:location:0:path', value: '/package-lock.json' }] },
    { purl: 'pkg:npm/half-bad@1.0.0', version: '1.0.0' },
    { purl: 'pkg:npm/half-bad@1.0.1', version: '1.0.1' },
    { purl: 'pkg:pypi/Colourama@0.1', version: '0.1' },
    { purl: 'pkg:npm/left-pad@1.3.0', version: '1.3.0' },
  ],
};

describe('malicious package matching (W18-37)', () => {
  const hits = matchMalicious(packagesFromSbom(sbom), index);

  it('matches every version when the advisory affects all, and only listed versions otherwise', () => {
    expect(hits.map((h) => `${h.pkg.name}@${h.pkg.version}:${h.advisory.id}`).sort()).toEqual([
      'Colourama@0.1:MAL-2024-3',
      'evil-lib@2.0.0:MAL-2024-1',
      'half-bad@1.0.1:MAL-2024-2',
    ]);
  });

  it('files each hit at severity 5 on the manifest syft recorded', () => {
    const { finding } = maliciousFinding(hits.find((h) => h.pkg.name === 'evil-lib')!);
    expect(finding).toMatchObject({
      dimension: 'dependency',
      severity: 5,
      confidence: 5,
      file: 'package-lock.json',
      ruleId: 'MAL-2024-1',
      scannerKey: 'dependency_cve',
    });
    expect(finding.rationale).toMatch(/installing it is the compromise/);
  });

  it('reports a missing or broken index instead of reading it as clean', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mal-'));
    const missing = loadMaliciousIndex(path.join(dir, 'nope.json'));
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toMatch(/not synced/);
    writeFileSync(path.join(dir, 'bad.json'), '{"entries": 3}');
    expect(loadMaliciousIndex(path.join(dir, 'bad.json')).ok).toBe(false);
  });
});

describe('index builder (deploy/build-malicious-index.py)', () => {
  it('keeps only MAL-* advisories and records all-versions vs listed versions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mal-build-'));
    const zipPath = path.join(dir, 'npm.zip');
    const py = `
import json, zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('MAL-2024-1.json', json.dumps({'id':'MAL-2024-1','summary':'bad','affected':[{'package':{'ecosystem':'npm','name':'Evil-Lib'},'ranges':[{'type':'SEMVER','events':[{'introduced':'0'}]}]}]}))
    z.writestr('MAL-2024-2.json', json.dumps({'id':'MAL-2024-2','affected':[{'package':{'ecosystem':'npm','name':'half-bad'},'versions':['1.0.1']}]}))
    z.writestr('MAL-2023-462.json', json.dumps({'id':'MAL-2023-462','affected':[{'package':{'ecosystem':'npm','name':'fsevents'},'ranges':[{'type':'SEMVER','events':[{'introduced':'1.0.0'},{'fixed':'1.2.11'}]}]}]}))
    z.writestr('GHSA-xxxx.json', json.dumps({'id':'GHSA-xxxx','affected':[{'package':{'ecosystem':'npm','name':'not-malicious'}}]}))
`;
    execFileSync('python3', ['-c', py, zipPath]);
    execFileSync('python3', [BUILDER, dir, `npm=${zipPath}`]);
    const built = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')) as MaliciousIndex;
    expect(Object.keys(built.entries['npm']!).sort()).toEqual(['evil-lib', 'fsevents', 'half-bad']);
    // 2026-10-28: a bounded range is kept, not widened to every version.
    expect(built.entries['npm']!['fsevents']![0]).toMatchObject({
      versions: null,
      ranges: [{ introduced: '1.0.0', fixed: '1.2.11' }],
    });
    expect(built.entries['npm']!['evil-lib']![0]!.ranges).toBeUndefined();
    expect(built.entries['npm']!['evil-lib']![0]!.versions).toBeNull();
    expect(built.entries['npm']!['half-bad']![0]!.versions).toEqual(['1.0.1']);
  });

  // 2026-10-28 walkthrough: MAL-2023-462 covers fsevents >=1.0.0 <1.2.11, but
  // the index stored it as every version, so legitimate fsevents 2.3.3 on
  // outline was reported as "a known malicious package".
  it('matches only inside a bounded range, and matches when it cannot tell', () => {
    const ranged: MaliciousIndex = {
      generated: '',
      source: '',
      entries: {
        npm: {
          fsevents: [{ id: 'MAL-2023-462', summary: '', versions: null, ranges: [{ introduced: '1.0.0', fixed: '1.2.11' }] }],
          'last-bad': [{ id: 'MAL-L', summary: '', versions: null, ranges: [{ introduced: '0', last_affected: '2.0.0' }] }],
        },
      },
    };
    const at = (name: string, version: string) =>
      matchMalicious([{ name, version, ecosystem: 'npm', purl: `pkg:npm/${name}@${version}`, file: null }], ranged).length;
    expect(at('fsevents', '2.3.3')).toBe(0);
    expect(at('fsevents', '1.2.11')).toBe(0);
    expect(at('fsevents', '1.2.10')).toBe(1);
    expect(at('fsevents', '1.0.0')).toBe(1);
    expect(at('fsevents', '1.2.11-rc.1')).toBe(1); // a pre-release sorts before its release
    expect(at('last-bad', '2.0.0')).toBe(1);
    expect(at('last-bad', '2.0.1')).toBe(0);
    expect(at('fsevents', 'not-a-version')).toBe(1); // cannot clear what it cannot compare
  });

  it('orders SemVer versions, pre-releases included', () => {
    expect(compareSemver('1.2.10', '1.2.9')).toBe(1);
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareSemver('1.0', '1.0.0')).toBeNull();
  });
});
