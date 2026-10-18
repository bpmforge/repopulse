import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBundle,
  generateSigningKey,
  isSafePath,
  keyIdOf,
  verifyBundle,
  type Bundle,
} from './bundle.js';
import {
  fetchBundleText,
  installBundle,
  installFromFile,
  readCurrent,
  rollback,
  storeStatus,
} from './store.js';

// W19-06. A bundle is trusted for its signature, not its channel: a changed
// byte, an unknown key, an unsafe path or an old version replayed all refuse,
// and nothing is ever half-installed.

const KEY = generateSigningKey();
const OTHER = generateSigningKey();
const FILES = new Map([
  ['semgrep/bpm-baseline.v1.yaml', 'rules:\n  - id: bpm-a\n'],
  ['code-health/anti-slop.v1.yaml', 'rules:\n  - id: bpm-b\n'],
]);
const make = (version: string, files = FILES, key = KEY) =>
  buildBundle({
    files,
    version,
    createdAt: '2026-10-18T00:00:00.000Z',
    privateKeyPem: key.privateKeyPem,
  });

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bundle-'));
  mkdirSync(path.join(root, 'trusted-keys'));
  writeFileSync(path.join(root, 'trusted-keys', 'publisher.pem'), KEY.publicKeyPem);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('verifyBundle', () => {
  it('accepts a bundle signed by a trusted key, and names the key', () => {
    const r = verifyBundle(JSON.stringify(make('2026.10.18.1')), [KEY.publicKeyPem]);
    expect(r).toMatchObject({ ok: true, keyId: keyIdOf(KEY.publicKeyPem) });
  });

  it('refuses a file whose content was changed after signing', () => {
    const b = make('2026.10.18.1');
    b.files[0]!.content = b.files[0]!.content.replace(/bpm-./, 'bpm-z'); // same length, so only the hash can catch it
    expect(verifyBundle(b, [KEY.publicKeyPem])).toMatchObject({ ok: false, code: 'bad_hash' });
  });

  it('refuses a manifest edit (the version) even when every file still hashes', () => {
    const b = make('2026.10.18.1');
    b.version = '2026.10.19.1';
    expect(verifyBundle(b, [KEY.publicKeyPem])).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('refuses a key the operator does not trust, naming whose it was', () => {
    const r = verifyBundle(make('2026.10.18.1', FILES, OTHER), [KEY.publicKeyPem]);
    expect(r).toMatchObject({ ok: false, code: 'unknown_key' });
    expect(!r.ok && r.reason).toContain(keyIdOf(OTHER.publicKeyPem));
  });

  it('refuses a recorded size that is not the real one', () => {
    const b = make('2026.10.18.1');
    b.files[0]!.bytes += 1;
    expect(verifyBundle(b, [KEY.publicKeyPem])).toMatchObject({ ok: false, code: 'bad_size' });
  });

  it.each([
    '../evil.yaml',
    '/etc/passwd.yaml',
    'a/../../b.yaml',
    'semgrep/x.sh',
    'a\\b.yaml',
    '.hidden.yaml',
  ])('refuses the unsafe path %s', (p) => {
    expect(isSafePath(p)).toBe(false);
    const b = make('2026.10.18.1');
    b.files[0]!.path = p;
    expect(verifyBundle(b, [KEY.publicKeyPem])).toMatchObject({ ok: false, code: 'unsafe_path' });
  });

  it('refuses a duplicate path, a bad version and garbage', () => {
    const b = make('2026.10.18.1');
    b.files.push({ ...b.files[0]! });
    expect(verifyBundle(b, [KEY.publicKeyPem])).toMatchObject({ code: 'unsafe_path' });
    expect(() => make('v2')).toThrow(/YYYY\.MM\.DD\.N/);
    expect(verifyBundle('not json', [KEY.publicKeyPem])).toMatchObject({ code: 'malformed' });
    expect(verifyBundle({ hello: 1 }, [KEY.publicKeyPem])).toMatchObject({ code: 'malformed' });
  });
});

describe('installBundle', () => {
  it('refuses to install anything when the operator has trusted no key', () => {
    rmSync(path.join(root, 'trusted-keys'), { recursive: true });
    expect(installBundle(root, make('2026.10.18.1'))).toMatchObject({
      ok: false,
      code: 'no_trusted_keys',
    });
  });

  it('installs read-only files under versions/, points current at them, and records it', () => {
    const r = installBundle(root, make('2026.10.18.1'), {
      now: () => new Date('2026-10-18T01:00:00Z'),
    });
    expect(r).toEqual({ ok: true, version: '2026.10.18.1', previous: null });
    const file = path.join(root, 'versions/2026.10.18.1/semgrep/bpm-baseline.v1.yaml');
    expect(readFileSync(file, 'utf8')).toBe(FILES.get('semgrep/bpm-baseline.v1.yaml'));
    expect(statSync(file).mode & 0o222).toBe(0); // nobody can write it
    expect(lstatSync(path.join(root, 'current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(root, 'current'))).toBe(path.join('versions', '2026.10.18.1'));
    expect(readCurrent(root)).toMatchObject({
      version: '2026.10.18.1',
      keyId: keyIdOf(KEY.publicKeyPem),
      history: [],
    });
  });

  it('leaves no stage directory behind', () => {
    installBundle(root, make('2026.10.18.1'));
    expect(readdirSync(path.join(root, 'versions')).filter((n) => n.startsWith('.stage-'))).toEqual(
      [],
    );
  });

  it('refuses a downgrade and a repeat, but a newer version moves the pointer and keeps history', () => {
    installBundle(root, make('2026.10.18.1'));
    expect(installBundle(root, make('2026.10.18.1'))).toMatchObject({
      ok: false,
      code: 'same_version',
    });
    expect(installBundle(root, make('2026.10.17.9'))).toMatchObject({
      ok: false,
      code: 'downgrade',
    });
    expect(installBundle(root, make('2026.10.19.1'))).toMatchObject({
      ok: true,
      previous: '2026.10.18.1',
    });
    expect(readCurrent(root)).toMatchObject({ version: '2026.10.19.1', history: ['2026.10.18.1'] });
  });

  it('does not touch the installed version when a bad bundle arrives', () => {
    installBundle(root, make('2026.10.18.1'));
    const bad = make('2026.10.19.1');
    bad.files[0]!.content = bad.files[0]!.content.replace(/bpm-./, 'bpm-z');
    expect(installBundle(root, bad)).toMatchObject({ ok: false, code: 'bad_hash' });
    expect(readCurrent(root).version).toBe('2026.10.18.1');
    expect(existsSync(path.join(root, 'versions/2026.10.19.1'))).toBe(false);
  });

  it('keeps only the three newest versions on disk', () => {
    for (const v of [
      '2026.10.01.1',
      '2026.10.02.1',
      '2026.10.03.1',
      '2026.10.04.1',
      '2026.10.05.1',
    ]) {
      installBundle(root, make(v));
    }
    expect(readdirSync(path.join(root, 'versions')).sort()).toEqual([
      '2026.10.03.1',
      '2026.10.04.1',
      '2026.10.05.1',
    ]);
  });
});

describe('rollback', () => {
  it('moves back to the previous version, and the rollback can itself be undone', () => {
    installBundle(root, make('2026.10.18.1'));
    installBundle(root, make('2026.10.19.1'));
    expect(rollback(root)).toEqual({ ok: true, version: '2026.10.18.1' });
    expect(readlinkSync(path.join(root, 'current'))).toContain('2026.10.18.1');
    expect(rollback(root)).toEqual({ ok: true, version: '2026.10.19.1' });
  });

  it('says so when there is nothing to go back to', () => {
    installBundle(root, make('2026.10.18.1'));
    expect(rollback(root)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no earlier/),
    });
  });

  it('can return to the rulepacks that shipped with the product', () => {
    installBundle(root, make('2026.10.18.1'));
    expect(rollback(root, { toShipped: true })).toEqual({ ok: true, version: null });
    expect(existsSync(path.join(root, 'current'))).toBe(false);
    expect(storeStatus(root)).toMatchObject({
      usingShipped: true,
      version: null,
      consistent: true,
    });
    expect(readCurrent(root).history).toEqual(['2026.10.18.1']);
  });
});

describe('status', () => {
  it("reports age and staleness against the operator's limit", () => {
    installBundle(root, make('2026.10.18.1'), { now: () => new Date('2026-08-01T00:00:00Z') });
    const s = storeStatus(root, { now: () => new Date('2026-10-18T00:00:00Z'), maxAgeDays: 45 });
    expect(s).toMatchObject({
      version: '2026.10.18.1',
      ageDays: 78,
      stale: true,
      consistent: true,
    });
  });

  it('flags a pointer and record that disagree (someone edited one by hand)', () => {
    installBundle(root, make('2026.10.18.1'));
    writeFileSync(
      path.join(root, 'current.json'),
      JSON.stringify({ version: '2026.10.20.1', keyId: null, installedAt: null, history: [] }),
    );
    expect(storeStatus(root).consistent).toBe(false);
  });
});

describe('the offline path and the guarded download', () => {
  it('installs a bundle that arrived as a file, touching no network', () => {
    const file = path.join(root, 'incoming.json');
    writeFileSync(file, JSON.stringify(make('2026.10.18.1')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(installFromFile(root, file)).toMatchObject({ ok: true, version: '2026.10.18.1' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('reports an unreadable file as an error, not a crash', () => {
    expect(installFromFile(root, path.join(root, 'missing.json'))).toMatchObject({
      ok: false,
      code: 'io',
    });
  });

  const ok = (body: string, init: ResponseInit = {}) =>
    (async () => new Response(body, init)) as unknown as typeof fetch;
  it('fetches only over HTTPS', async () => {
    expect(await fetchBundleText('http://example.com/b.json')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/HTTPS only/),
    });
  });
  it('does not follow a redirect, and says where it pointed', async () => {
    const f = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.example/b.json' },
      })) as unknown as typeof fetch;
    const r = await fetchBundleText('https://example.com/b.json', { fetchImpl: f });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain('elsewhere.example');
  });
  it('reports a non-200 and an oversized body', async () => {
    expect(
      await fetchBundleText('https://example.com/b.json', {
        fetchImpl: ok('nope', { status: 404 }),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/404/) });
    expect(
      await fetchBundleText('https://example.com/b.json', {
        fetchImpl: ok('x'.repeat(50)),
        maxBytes: 10,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/exceeds/) });
  });
  it('returns the text for a good answer, which still has to verify before it installs', async () => {
    const bundle: Bundle = make('2026.10.18.1');
    const r = await fetchBundleText('https://example.com/b.json', {
      fetchImpl: ok(JSON.stringify(bundle)),
    });
    expect(r.ok && JSON.parse(r.text).version).toBe('2026.10.18.1');
    // The channel adds no trust: the same text from an untrusted signer is refused.
    const evil = JSON.stringify(make('2026.10.19.1', FILES, OTHER));
    expect(installBundle(root, evil)).toMatchObject({ ok: false, code: 'unknown_key' });
  });
});
