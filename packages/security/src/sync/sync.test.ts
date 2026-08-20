import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNpmPackument, parsePypiProject, registryUrl } from './release-meta.js';
import { parseEolProduct, EOL_API_BASE } from './eol.js';

// db-sync parsers (W10-02, FR-REG-2/3).
//
// The fixtures are CAPTURED RESPONSES from registry.npmjs.org, pypi.org and
// endoflife.date v1 (2026-08-19), trimmed but not rewritten. A hand-invented
// fixture would only prove the parser agrees with my memory of the API.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/w10-02');
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

describe('npm packument', () => {
  it('reads the latest version and its real release date', () => {
    const facts = parseNpmPackument('request', fixture('npm-request.json'));
    expect(facts.latestVersion).toBe('2.88.2');
    expect(facts.latestReleaseAt?.toISOString()).toBe('2020-02-11T16:35:36.122Z');
  });

  it('treats the deprecation MESSAGE as the flag, because npm has no boolean', () => {
    const facts = parseNpmPackument('request', fixture('npm-request.json'));
    expect(facts.deprecated).toBe(true);
  });

  it('leaves yanked NULL for npm — the ecosystem has no such concept', () => {
    // false would be a claim about a mechanism npm does not have: an npm
    // version is unpublished and disappears, never marked.
    expect(parseNpmPackument('request', fixture('npm-request.json')).yanked).toBeNull();
  });

  it('captures only the versions asked for, not the whole time map', () => {
    const facts = parseNpmPackument('request', fixture('npm-request.json'), ['2.88.0']);
    expect(Object.keys(facts.versionDates).sort()).toEqual(['2.88.0', '2.88.2']);
  });

  it('survives a body that is not a packument at all', () => {
    const facts = parseNpmPackument('ghost', { error: 'Not found' });
    expect(facts.latestVersion).toBeNull();
    expect(facts.deprecated).toBe(false);
  });

  it('keeps a scoped package name unescaped in its URL', () => {
    expect(registryUrl('npm', '@scope/pkg')).toBe('https://registry.npmjs.org/@scope%2Fpkg');
  });
});

describe('pypi project', () => {
  it('reads version, upload date and the PEP 592 yank flag', () => {
    const facts = parsePypiProject('requests', fixture('pypi-requests.json'), ['2.25.0']);
    expect(facts.latestVersion).toBe('2.34.2');
    expect(facts.yanked).toBe(false);
    expect(facts.license).toBe('Apache-2.0');
    expect(facts.versionDates['2.25.0']).toBeTruthy();
  });
});

describe('endoflife.date v1', () => {
  it('maps eolFrom/eoasFrom, which the legacy shape called eol/support', () => {
    const cycles = parseEolProduct('nodejs', fixture('eol-nodejs.json'));
    const node25 = cycles.find((c) => c.cycle === '25');
    expect(node25?.eolDate?.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(node25?.supportUntil?.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(node25?.latestVersion).toBe('25.9.0');
  });

  it('returns nothing rather than throwing on an unexpected body', () => {
    expect(parseEolProduct('nodejs', { result: null })).toEqual([]);
  });

  it('points at the v1 endpoint, not the legacy one', () => {
    expect(EOL_API_BASE).toBe('https://endoflife.date/api/v1/products');
  });
});
