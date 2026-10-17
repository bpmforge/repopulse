import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The SBOM normaliser (W18-51): gives a Swift package the namespaced name
// grype's database indexes. It lives in deploy/scan-tools because it runs in the
// scan image; the tests import that same file, so there is one implementation.

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../deploy/scan-tools/sbom-normalise.mjs',
);

interface Normaliser {
  swiftPurlSegments(purl: unknown): string[] | null;
  databaseName(component: unknown): string | null;
  normaliseSbom(document: unknown): { document: Record<string, unknown>; rewritten: number };
}
const mod = (await import(pathToFileURL(SCRIPT).href)) as Normaliser;

const swift = {
  type: 'library',
  name: 'swift-nio',
  version: '2.40.0',
  purl: 'pkg:swift/github.com/apple/swift-nio@2.40.0',
};

describe('what the database calls a Swift package', () => {
  it('is the purl path: repository host, owner and name', () => {
    expect(mod.databaseName(swift)).toBe('github.com/apple/swift-nio');
  });

  it('leaves a package with no namespace alone: there is nothing to add', () => {
    expect(mod.databaseName({ name: 'swift-nio', purl: 'pkg:swift/swift-nio@2.40.0' })).toBeNull();
  });

  it('leaves other ecosystems alone, including a purl that merely contains "swift"', () => {
    expect(mod.databaseName({ name: 'x', purl: 'pkg:npm/swift/x@1.0.0' })).toBeNull();
    expect(mod.databaseName({ name: 'lodash', purl: 'pkg:npm/lodash@4.17.15' })).toBeNull();
    expect(
      mod.databaseName({ name: 'AFNetworking', purl: 'pkg:cocoapods/AFNetworking@2.5.0' }),
    ).toBeNull();
    expect(mod.databaseName({ name: 'a', purl: undefined })).toBeNull();
  });

  it('does not rename a component whose name is not the purl name, or one already renamed', () => {
    expect(mod.databaseName({ ...swift, name: 'something-else' })).toBeNull();
    expect(mod.databaseName({ ...swift, name: 'github.com/apple/swift-nio' })).toBeNull();
  });

  it('reads percent-encoded segments, and ignores the version, qualifiers and subpath', () => {
    expect(
      mod.databaseName({
        name: 'my lib',
        purl: 'pkg:swift/github.com/some%20org/my%20lib@1.0.0?repository_url=x#sub',
      }),
    ).toBe('github.com/some org/my lib');
  });
});

describe('normalising a document', () => {
  it('rewrites Swift components, including nested ones, and counts them', () => {
    const { document, rewritten } = mod.normaliseSbom({
      components: [
        swift,
        { name: 'lodash', purl: 'pkg:npm/lodash@4.17.15' },
        { name: 'outer', purl: 'pkg:npm/outer@1', components: [{ ...swift, name: 'swift-nio' }] },
      ],
    });
    const names = document.components as { name: string; components?: { name: string }[] }[];
    expect(rewritten).toBe(2);
    expect(names[0]!.name).toBe('github.com/apple/swift-nio');
    expect(names[1]!.name).toBe('lodash');
    expect(names[2]!.components![0]!.name).toBe('github.com/apple/swift-nio');
  });

  it('is a no-op on a document with no components', () => {
    expect(mod.normaliseSbom({}).rewritten).toBe(0);
  });

  it('refuses something that is not a document', () => {
    expect(() => mod.normaliseSbom(null)).toThrow(/not a CycloneDX/);
    expect(() => mod.normaliseSbom([])).toThrow(/not a CycloneDX/);
  });
});

describe('run as the scan image runs it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w18-51-'));

  it('writes the copy, leaves the original exactly as syft wrote it, and exits 0', () => {
    const input = path.join(dir, 'sbom.json');
    const output = path.join(dir, 'sbom.grype.json');
    const original = JSON.stringify({ components: [swift] });
    writeFileSync(input, original);
    execFileSync(process.execPath, [SCRIPT, input, output]);
    expect(readFileSync(input, 'utf8')).toBe(original);
    const copy = JSON.parse(readFileSync(output, 'utf8')) as { components: { name: string }[] };
    expect(copy.components[0]!.name).toBe('github.com/apple/swift-nio');
  });

  it('exits 2, says why on stderr, and writes nothing for unreadable input', () => {
    const input = path.join(dir, 'bad.json');
    const output = path.join(dir, 'bad.out.json');
    writeFileSync(input, 'not json');
    const result = spawnSync(process.execPath, [SCRIPT, input, output], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/sbom-normalise:/);
    expect(() => readFileSync(output)).toThrow();
  });

  it('exits 2 for a missing input and for no arguments', () => {
    expect(
      spawnSync(process.execPath, [SCRIPT, path.join(dir, 'nope.json'), path.join(dir, 'o')])
        .status,
    ).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT]).status).toBe(2);
  });
});
