import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { compareVersions, verifyBundle, type Bundle, type VerifyFailure } from './bundle.js';

// Installing rulepack bundles (W19-06).
//
//   <root>/versions/<version>/...   one directory per installed bundle, read-only
//   <root>/current                  symlink to the active version (what the host sync mounts)
//   <root>/current.json             the audit record: version, key, when, and the history
//   <root>/trusted-keys/*.pem       the keys the OPERATOR trusts — the product ships none
//
// An install is a stage-verify-rename: nothing is visible until the whole
// bundle is on disk and re-hashed, and `current` moves by an atomic symlink
// swap, so a crash leaves the previous version active, never half of a new one.
// Rollback is a pointer move to a version still on disk; "use the shipped
// rulepacks" removes the pointer. Nothing here deletes a version it may need.

export const KEEP_VERSIONS = 3;

export interface CurrentRecord {
  version: string | null;
  keyId: string | null;
  installedAt: string | null;
  /** Newest first, excluding the current version. Rolled back to in this order. */
  history: string[];
}

export type InstallResult =
  | { ok: true; version: string; previous: string | null }
  | {
      ok: false;
      code: VerifyFailure | 'downgrade' | 'same_version' | 'no_trusted_keys' | 'io';
      reason: string;
    };

const versionsDir = (root: string) => path.join(root, 'versions');
const currentLink = (root: string) => path.join(root, 'current');
const recordPath = (root: string) => path.join(root, 'current.json');

export function readCurrent(root: string): CurrentRecord {
  try {
    return JSON.parse(readFileSync(recordPath(root), 'utf8')) as CurrentRecord;
  } catch {
    return { version: null, keyId: null, installedAt: null, history: [] };
  }
}

export function loadTrustedKeys(root: string): string[] {
  const dir = path.join(root, 'trusted-keys');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.pem'))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), 'utf8'));
}

/** Atomic: write a sibling temp name, then rename over the target. */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function pointTo(root: string, version: string | null): void {
  const link = currentLink(root);
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  if (version === null) {
    rmSync(link, { force: true });
    return;
  }
  symlinkSync(path.join('versions', version), tmp);
  renameSync(tmp, link);
}

function writeRecord(root: string, rec: CurrentRecord): void {
  atomicWrite(recordPath(root), `${JSON.stringify(rec, null, 2)}\n`);
}

function prune(root: string, rec: CurrentRecord): void {
  const keep = new Set([rec.version, ...rec.history].filter((v): v is string => v !== null));
  const ordered = [...keep].sort((a, b) => compareVersions(b, a)).slice(0, KEEP_VERSIONS);
  const dir = versionsDir(root);
  if (!existsSync(dir)) return;
  for (const v of readdirSync(dir)) {
    if (v.startsWith('.stage-')) continue;
    if (!ordered.includes(v)) {
      rmSync(path.join(dir, v), { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

export function installBundle(
  root: string,
  raw: unknown,
  options: { now?: () => Date; allowDowngrade?: boolean } = {},
): InstallResult {
  const trusted = loadTrustedKeys(root);
  if (trusted.length === 0) {
    return {
      ok: false,
      code: 'no_trusted_keys',
      reason: `no trusted keys in ${path.join(root, 'trusted-keys')} — add the publisher's public key (.pem) there first`,
    };
  }
  const verified = verifyBundle(raw, trusted);
  if (!verified.ok) return { ok: false, code: verified.code, reason: verified.reason };
  const bundle: Bundle = verified.bundle;

  const cur = readCurrent(root);
  if (cur.version !== null) {
    const cmp = compareVersions(bundle.version, cur.version);
    // A valid-but-old bundle replayed at the installer is an attack as much as
    // a mistake; going back is `rollback`, which is explicit.
    if (cmp === 0) {
      return {
        ok: false,
        code: 'same_version',
        reason: `version ${bundle.version} is already installed`,
      };
    }
    if (cmp < 0 && !options.allowDowngrade) {
      return {
        ok: false,
        code: 'downgrade',
        reason: `version ${bundle.version} is older than the installed ${cur.version}; use rollback to go back deliberately`,
      };
    }
  }

  const dir = versionsDir(root);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, bundle.version);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  const stage = mkdtempSync(path.join(dir, '.stage-'));
  try {
    for (const f of bundle.files) {
      const dest = path.join(stage, f.path);
      // Belt and braces after verifyBundle's path check: the resolved path must
      // stay inside the stage directory.
      if (!path.resolve(dest).startsWith(path.resolve(stage) + path.sep)) {
        throw new Error(`"${f.path}" resolves outside the install directory`);
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
      chmodSync(dest, 0o444);
    }
    renameSync(stage, target);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    return { ok: false, code: 'io', reason: err instanceof Error ? err.message : String(err) };
  }

  const history =
    cur.version !== null
      ? [cur.version, ...cur.history.filter((v) => v !== cur.version)]
      : cur.history;
  const rec: CurrentRecord = {
    version: bundle.version,
    keyId: verified.keyId,
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
    history: history.filter((v) => v !== bundle.version),
  };
  pointTo(root, bundle.version);
  writeRecord(root, rec);
  prune(root, rec);
  return { ok: true, version: bundle.version, previous: cur.version };
}

export type RollbackResult = { ok: true; version: string | null } | { ok: false; reason: string };

/** Back to the previous installed version, or (`toShipped`) to the rulepacks that shipped with the product. */
export function rollback(
  root: string,
  options: { toShipped?: boolean; now?: () => Date } = {},
): RollbackResult {
  const cur = readCurrent(root);
  const now = (options.now ?? (() => new Date()))().toISOString();
  if (options.toShipped) {
    pointTo(root, null);
    writeRecord(root, {
      version: null,
      keyId: null,
      installedAt: now,
      history: cur.version !== null ? [cur.version, ...cur.history] : cur.history,
    });
    return { ok: true, version: null };
  }
  const previous = cur.history.find((v) => existsSync(path.join(versionsDir(root), v)));
  if (previous === undefined) {
    return { ok: false, reason: 'there is no earlier installed version to go back to' };
  }
  const rest = cur.history.filter((v) => v !== previous);
  pointTo(root, previous);
  writeRecord(root, {
    version: previous,
    keyId: null,
    installedAt: now,
    // The version we left stays reachable, so a rollback can itself be undone.
    history: cur.version !== null ? [cur.version, ...rest] : rest,
  });
  return { ok: true, version: previous };
}

export interface StoreStatus {
  version: string | null;
  usingShipped: boolean;
  installedAt: string | null;
  ageDays: number | null;
  /** Older than `maxAgeDays` — a scanner on a stale pack still reports and looks green. */
  stale: boolean | null;
  history: string[];
  keyId: string | null;
  /** The symlink and the record agree. A mismatch means someone edited one by hand. */
  consistent: boolean;
}

export function storeStatus(
  root: string,
  options: { now?: () => Date; maxAgeDays?: number } = {},
): StoreStatus {
  const rec = readCurrent(root);
  const now = (options.now ?? (() => new Date()))();
  const max = options.maxAgeDays ?? 45;
  let linked: string | null = null;
  try {
    if (lstatSync(currentLink(root)).isSymbolicLink()) {
      linked = path.basename(readlinkSync(currentLink(root)));
    }
  } catch {
    linked = null;
  }
  const ageDays = rec.installedAt
    ? Math.floor((now.getTime() - Date.parse(rec.installedAt)) / 86_400_000)
    : null;
  return {
    version: rec.version,
    usingShipped: rec.version === null,
    installedAt: rec.installedAt,
    ageDays,
    stale: ageDays === null ? null : ageDays > max,
    history: rec.history,
    keyId: rec.keyId,
    consistent: linked === rec.version,
  };
}

/** Offline path: a bundle that arrived as a file, by any means. No network is touched. */
export function installFromFile(
  root: string,
  file: string,
  options?: Parameters<typeof installBundle>[2],
): InstallResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, code: 'io', reason: `cannot read ${file}: ${(err as Error).message}` };
  }
  return installBundle(root, text, options);
}

/**
 * Online path. HTTPS only, the operator's own URL, no redirect to another host,
 * a size cap and a timeout. What arrives is verified exactly like a file: the
 * channel adds no trust.
 */
export async function fetchBundleText(
  url: string,
  options: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: `"${url}" is not a URL` };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'bundles are fetched over HTTPS only' };
  const f = options.fetchImpl ?? fetch;
  try {
    const res = await f(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      return {
        ok: false,
        reason: `the server redirected${loc ? ` to ${loc}` : ''}; redirects are not followed — use the final URL`,
      };
    }
    if (!res.ok) return { ok: false, reason: `the server answered ${res.status}` };
    const max = options.maxBytes ?? 25 * 1024 * 1024;
    const text = await res.text();
    if (Buffer.byteLength(text) > max)
      return { ok: false, reason: `the bundle exceeds ${max} bytes` };
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      reason: `could not fetch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
