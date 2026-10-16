import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adviseFix, lowestFix, readFixGraphs } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../../fixtures/fixpaths');
const graphs = (dir: string) => readFixGraphs(path.join(FIXTURES, dir));

describe('fix paths from lockfile graphs (W18-36)', () => {
  const transitive = [
    ['npm', 'npm', 'ms', '2.0.0', 'express@4.17.1 → debug@2.6.9 → ms@2.0.0', 'overrides'],
    ['pnpm', 'npm', 'ms', '2.0.0', 'express@4.17.1 → debug@2.6.9 → ms@2.0.0', 'pnpm.overrides'],
    ['yarn', 'npm', 'ms', '2.0.0', 'express@4.17.1 → debug@2.6.9 → ms@2.0.0', 'resolutions'],
    ['poetry', 'python', 'idna', '2.10', 'requests@2.25.0 → idna@2.10', 'pyproject.toml'],
    ['uv', 'python', 'idna', '2.10', 'requests@2.25.0 → idna@2.10', 'override-dependencies'],
    ['cargo', 'rust-crate', 'bytes', '1.0.0', 'hyper@0.14.0 → bytes@1.0.0', 'cargo update -p bytes'],
  ] as const;

  it.each(transitive)('%s: names the direct dependency and a pin for a transitive package', (dir, type, name, version, chain, pin) => {
    const { graphs: g, unreadable } = graphs(dir);
    expect(unreadable).toEqual([]);
    const advice = adviseFix(g, { packageType: type, name, version, fixVersions: ['9.9.9'] });
    expect(advice?.kind).toBe('transitive');
    expect(advice?.chain.join(' → ')).toBe(chain);
    expect(advice?.text).toContain(pin);
    expect(advice?.text).toMatch(/must be read from its changelog or the registry/);
  });

  const direct = [
    ['npm', 'npm', 'minimist', '1.2.0'],
    ['pnpm', 'npm', 'minimist', '1.2.0'],
    ['yarn', 'npm', 'minimist', '1.2.0'],
    ['poetry', 'python', 'urllib3', '1.26.4'],
    ['uv', 'python', 'urllib3', '1.26.4'],
    ['cargo', 'rust-crate', 'smallvec', '1.4.0'],
  ] as const;

  it.each(direct)('%s: a direct dependency is the whole change', (dir, type, name, version) => {
    const advice = adviseFix(graphs(dir).graphs, { packageType: type, name, version, fixVersions: ['2.0.0', '1.9.0'] });
    expect(advice?.kind).toBe('direct');
    expect(advice?.text).toContain(`from ${version} to 1.9.0`);
  });

  it('go: raises the requirement in place, direct or indirect', () => {
    const { graphs: g } = graphs('go');
    const indirect = adviseFix(g, { packageType: 'go-module', name: 'golang.org/x/net', version: 'v0.1.0', fixVersions: ['0.17.0'] });
    expect(indirect?.kind).toBe('go_get');
    expect(indirect?.text).toContain('go get golang.org/x/net@v0.17.0');
    expect(indirect?.text).toMatch(/indirect/);
    const direct = adviseFix(g, { packageType: 'go-module', name: 'github.com/gin-gonic/gin', version: 'v1.7.0', fixVersions: ['1.9.1'] });
    expect(direct?.text).toMatch(/a direct requirement/);
  });

  it('says plainly when no fixed version exists', () => {
    const advice = adviseFix(graphs('npm').graphs, { packageType: 'npm', name: 'ms', version: '2.0.0', fixVersions: [] });
    expect(advice?.kind).toBe('no_fix');
    expect(advice?.text).toMatch(/No fixed version of ms is published/);
    expect(advice?.text).toMatch(/express@4\.17\.1/);
  });

  it('admits when no graph can trace the package, and skips ecosystems it does not model', () => {
    const none = adviseFix([], { packageType: 'npm', name: 'ms', version: '2.0.0', fixVersions: ['2.1.3'] });
    expect(none?.kind).toBe('unreadable');
    expect(none?.text).toMatch(/could not trace/);
    expect(adviseFix([], { packageType: 'deb', name: 'x', version: '1', fixVersions: ['2'] })).toBeNull();
  });

  it('picks the lowest listed fix', () => {
    expect(lowestFix(['2.0.0', '1.10.0', '1.9.0'])).toBe('1.9.0');
    expect(lowestFix([])).toBeNull();
  });

  it('reports a lockfile it cannot read instead of inventing a graph', () => {
    // A yarn berry lockfile has no v1 header.
    const { readYarnGraph } = awaitedReaders;
    expect(readYarnGraph('__metadata:\n  version: 6\n', 'yarn.lock', null)).toBeNull();
  });
});

import * as awaitedReaders from './readers.js';
