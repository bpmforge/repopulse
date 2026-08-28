import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_SOURCES, archiveRoot, buildTarball } from '@repopulse/shared';
import { extractTarball } from './extract.js';

// W16-30. The fake forge's archive, read by the parser that will actually read
// it.
//
// The fake served no tarball route at all, so every snapshot scanner got a 404
// and had never run once against it — in the demo or in e2e. Two things have to
// hold for the fix to be worth anything, and neither is "the route returns
// 200": the bytes must be a gzipped ustar archive that snapshot/tar.ts parses,
// and the tree that lands on disk must be the tree the fixture describes.
//
// Asserted HERE, in the package that owns the parser, because a test living
// next to the builder would only prove the builder agrees with itself.

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'repopulse-fixture-tar-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the fake forge archive (W16-30)', () => {
  it('extracts to the fixture tree, root prefix stripped', async () => {
    const bytes = buildTarball(archiveRoot('acme/payments', 'abc1234def'), FIXTURE_SOURCES);
    const dest = scratch();

    const result = await extractTarball(bytes, dest);

    expect(result.filesWritten).toBe(FIXTURE_SOURCES.length);
    expect(result.bytesWritten).toBeGreaterThan(0);
    // Every guard saw nothing, which is the evidence that nothing needed
    // guarding rather than that the guards were skipped.
    expect(Object.values(result.dropped).every((n) => n === 0)).toBe(true);
    expect(result.droppedNames).toEqual([]);

    // stripComponents defaults to 1, so `acme-payments-abc1234/src/…` lands as
    // `src/…` — findings carry the repo's own paths, not the archive's.
    expect(readdirSync(dest).sort()).toEqual(['README.md', 'package.json', 'src']);
    const pricing = readFileSync(path.join(dest, 'src/pricing.ts'), 'utf8');
    expect(pricing).toBe(FIXTURE_SOURCES.find((f) => f.path === 'src/pricing.ts')?.content);
  });

  it('names its root the way GitHub does, so the prefix is not a surprise', () => {
    expect(archiveRoot('acme/payments', 'abc1234def5678')).toBe('acme-payments-abc1234');
    // A sweep with no resolved head SHA still has to produce a valid name
    // rather than `acme-payments-`.
    expect(archiveRoot('acme/payments', '')).toBe('acme-payments-head');
  });

  it('is byte-identical for the same commit, so two runs agree', () => {
    // A scan is reproducible for a SHA (SECURITY_SUITE §1). An archive carrying
    // Date.now() in its headers would make two runs of one commit differ for no
    // reason anybody could act on.
    const a = buildTarball(archiveRoot('acme/payments', 'abc1234'), FIXTURE_SOURCES);
    const b = buildTarball(archiveRoot('acme/payments', 'abc1234'), FIXTURE_SOURCES);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('carries something for the scanners to find', async () => {
    // A fixture that is clean cannot tell a working scanner from a broken one.
    const dest = scratch();
    await extractTarball(buildTarball(archiveRoot('a/b', 'c'), FIXTURE_SOURCES), dest);
    const settle = readFileSync(path.join(dest, 'src/settle.ts'), 'utf8');
    expect(settle).toMatch(/catch \{/);
    const quoting = readFileSync(path.join(dest, 'src/quoting.ts'), 'utf8');
    const pricing = readFileSync(path.join(dest, 'src/pricing.ts'), 'utf8');
    // The duplicated block, so the duplication tools have a real clone to see.
    expect(quoting).toContain("if (customer.tier === 'gold') {");
    expect(pricing).toContain("if (customer.tier === 'gold') {");
  });

  it('refuses a path ustar cannot hold rather than writing a broken header', () => {
    // 100 bytes is the ustar name limit; a longer path needs a PAX header,
    // which snapshot/tar.ts deliberately does not support. Failing here beats
    // failing inside the parser on a machine that is mid-scan.
    expect(() => buildTarball('root', [{ path: `${'x'.repeat(120)}.ts`, content: '' }])).toThrow(
      /too long for ustar/,
    );
  });
});
