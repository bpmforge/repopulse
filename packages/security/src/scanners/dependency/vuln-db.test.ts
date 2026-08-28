import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVulnDb } from './tools.js';

// The vulnerability-database guard (W8-06, extended in W16-36).
//
// The original rule: grype with no database reports nothing, and a repository
// with no findings is indistinguishable from a repository nobody checked. So a
// missing database fails the scan before a container starts.
//
// W16-36 found the same problem one step along. grype also refuses a database
// older than five days — it exits 1 and explains itself only on stderr, which
// did not survive the sandbox. The first real run of this scanner reported
// "grype exited 1" to the screen and nothing else, which is true and useless.

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'repopulse-vulndb-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A database directory grype's own layout would produce. */
function makeDb(root: string, builtIso: string | null): void {
  const schema = path.join(root, '6');
  mkdirSync(schema, { recursive: true });
  writeFileSync(path.join(schema, 'vulnerability.db'), 'not really sqlite');
  if (builtIso !== null) {
    writeFileSync(
      path.join(schema, 'import.json'),
      JSON.stringify({
        digest: 'xxh64:test',
        source: `https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.9_${builtIso}_1787206628.tar.zst?checksum=sha256%3Aabc`,
        client_version: 'v6.1.9',
      }),
    );
  }
}

const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');

describe('checkVulnDb', () => {
  it('names the sync script when there is no database at all', () => {
    const result = checkVulnDb(path.join(scratch(), 'nope'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/scan-db-sync\.sh/);
  });

  it('accepts a fresh database and reports its schema', () => {
    const root = scratch();
    makeDb(root, daysAgo(1));
    const result = checkVulnDb(root);
    expect(result).toEqual({ ok: true, schema: '6' });
  });

  it('REFUSES a stale one, in grype\'s terms and with the command (W16-36)', () => {
    // Eight days is what the real database on the dev machine was, and what
    // produced the bare "grype exited 1" on screen.
    const root = scratch();
    makeDb(root, daysAgo(8));
    const result = checkVulnDb(root);
    expect(result.ok).toBe(false);
    const reason = result.ok === false ? result.reason : '';
    expect(reason).toMatch(/8 days old/);
    expect(reason).toMatch(/refuses one over 5/);
    expect(reason).toMatch(/scan-db-sync\.sh/);
  });

  it('proceeds when it cannot DATE the database, rather than refusing', () => {
    // A database this cannot date is not thereby a database that is old, and
    // failing the scan on that basis would be its own false alarm.
    const root = scratch();
    makeDb(root, null);
    expect(checkVulnDb(root)).toEqual({ ok: true, schema: '6' });
  });

  it('dates it from grype\'s OWN record, not the file mtime', () => {
    // scan-db-sync.sh copies the directory, so mtime is when it was COPIED —
    // a fresh copy of a stale database would report as new. The files here are
    // written now and the record says eight days.
    const root = scratch();
    makeDb(root, daysAgo(8));
    expect(checkVulnDb(root).ok).toBe(false);
  });
});
