import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

// Rulepack update bundles (W19-06).
//
// The product's rulepacks have always shipped with the code, and a host-side
// cron (deploy/scan-db-sync.sh) mounts them read-only into the scan container.
// What was missing is a way to MOVE THEM FORWARD between releases that a
// customer can trust: versioned, verifiable, reversible, and installable
// without a network.
//
// A bundle is ONE JSON file: the complete rulepack tree, each file with its
// SHA-256, and an Ed25519 signature over the manifest. Everything a verifier
// needs is in the file, so a bundle can arrive by download, by USB stick, or by
// email — the signature, not the channel, is what makes it trustworthy.
//
// THE VERIFIER REFUSES, IT DOES NOT REPAIR. Any hash that does not match, any
// path that could leave the install directory, any signature that no trusted
// key verifies, makes the whole bundle unusable. There is no partial install.

export const BUNDLE_SCHEMA = 1;
export const BUNDLE_KIND = 'rulepack-bundle';

/** Versions are dates plus a per-day counter, so "newer" is a comparison, not a guess. */
export const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

const MAX_FILES = 2_000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_EXT = /\.(ya?ml|json|txt|md)$/i;

export interface BundleFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Bundle {
  schema: typeof BUNDLE_SCHEMA;
  kind: typeof BUNDLE_KIND;
  version: string;
  createdAt: string;
  files: (BundleFileEntry & { content: string })[];
  signature: { alg: 'ed25519'; keyId: string; sig: string };
}

export type VerifyFailure =
  | 'malformed'
  | 'unsupported_schema'
  | 'bad_version'
  | 'unsafe_path'
  | 'bad_hash'
  | 'bad_size'
  | 'too_large'
  | 'unknown_key'
  | 'bad_signature';

export type VerifyResult =
  { ok: true; bundle: Bundle; keyId: string } | { ok: false; code: VerifyFailure; reason: string };

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Short, stable identifier for a public key: the first 16 hex of the SHA-256 of its DER. */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return sha256(der as Buffer).slice(0, 16);
}

export function generateSigningKey(): {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem,
    keyId: keyIdOf(publicKeyPem),
  };
}

/** The exact bytes that are signed: a fixed-order manifest with no file contents. */
export function signedBytes(
  b: Pick<Bundle, 'schema' | 'kind' | 'version' | 'createdAt' | 'files'>,
): Buffer {
  const files = [...b.files]
    .sort((x, y) => x.path.localeCompare(y.path))
    .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));
  return Buffer.from(
    JSON.stringify({
      schema: b.schema,
      kind: b.kind,
      version: b.version,
      createdAt: b.createdAt,
      files,
    }),
  );
}

export function isSafePath(p: string): boolean {
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const segments = p.split('/');
  return (
    segments.length >= 1 &&
    segments.every((s) => SAFE_SEGMENT.test(s) && s !== '..') &&
    ALLOWED_EXT.test(segments.at(-1)!)
  );
}

export function buildBundle(args: {
  files: ReadonlyMap<string, string>;
  version: string;
  createdAt: string;
  privateKeyPem: string;
}): Bundle {
  if (!VERSION_PATTERN.test(args.version)) {
    throw new Error(`version "${args.version}" is not YYYY.MM.DD.N`);
  }
  const files = [...args.files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => {
      if (!isSafePath(path)) throw new Error(`refusing to bundle unsafe path "${path}"`);
      return { path, sha256: sha256(content), bytes: Buffer.byteLength(content), content };
    });
  const head = {
    schema: BUNDLE_SCHEMA,
    kind: BUNDLE_KIND,
    version: args.version,
    createdAt: args.createdAt,
    files,
  } as const;
  const privateKey = createPrivateKey(args.privateKeyPem);
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return {
    ...head,
    signature: {
      alg: 'ed25519',
      keyId: keyIdOf(publicPem),
      sig: sign(null, signedBytes(head), privateKey).toString('base64'),
    },
  };
}

const fail = (code: VerifyFailure, reason: string): VerifyResult => ({ ok: false, code, reason });

/**
 * Checks a bundle against the keys the OPERATOR trusts. A bundle signed by a
 * key not in `trustedKeysPem` is refused with the key id it names, so the
 * operator can see whose key it was without having to trust it.
 */
export function verifyBundle(raw: unknown, trustedKeysPem: readonly string[]): VerifyResult {
  let b: Bundle;
  try {
    b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Bundle;
  } catch {
    return fail('malformed', 'the bundle is not valid JSON');
  }
  if (
    !b ||
    typeof b !== 'object' ||
    b.kind !== BUNDLE_KIND ||
    !Array.isArray(b.files) ||
    !b.signature
  ) {
    return fail('malformed', 'the file is not a rulepack bundle');
  }
  if (b.schema !== BUNDLE_SCHEMA) {
    return fail(
      'unsupported_schema',
      `bundle schema ${String(b.schema)} is not supported (expected ${BUNDLE_SCHEMA})`,
    );
  }
  if (typeof b.version !== 'string' || !VERSION_PATTERN.test(b.version)) {
    return fail('bad_version', `version "${String(b.version)}" is not YYYY.MM.DD.N`);
  }
  if (b.files.length === 0 || b.files.length > MAX_FILES) {
    return fail('too_large', `a bundle holds 1-${MAX_FILES} files, this one has ${b.files.length}`);
  }

  let total = 0;
  const seen = new Set<string>();
  for (const f of b.files) {
    if (typeof f?.path !== 'string' || !isSafePath(f.path)) {
      return fail('unsafe_path', `"${String(f?.path)}" is not a safe relative rulepack path`);
    }
    if (seen.has(f.path)) return fail('unsafe_path', `"${f.path}" appears twice`);
    seen.add(f.path);
    if (typeof f.content !== 'string') return fail('malformed', `"${f.path}" has no content`);
    const actualBytes = Buffer.byteLength(f.content);
    total += actualBytes;
    if (actualBytes !== f.bytes) {
      return fail(
        'bad_size',
        `"${f.path}" is ${actualBytes} bytes but the manifest says ${f.bytes}`,
      );
    }
    if (sha256(f.content) !== f.sha256) {
      return fail(
        'bad_hash',
        `"${f.path}" does not match its recorded SHA-256 — the file was altered`,
      );
    }
  }
  if (total > MAX_TOTAL_BYTES)
    return fail('too_large', `${total} bytes exceeds the ${MAX_TOTAL_BYTES} limit`);

  if (b.signature.alg !== 'ed25519')
    return fail('bad_signature', `unsupported signature algorithm "${b.signature.alg}"`);
  const trusted = trustedKeysPem.map((pem) => ({ pem, id: keyIdOf(pem) }));
  const key = trusted.find((k) => k.id === b.signature.keyId);
  if (!key) {
    return fail(
      'unknown_key',
      `the bundle is signed by key ${b.signature.keyId}, which is not among the ${trusted.length} trusted key(s)`,
    );
  }
  const ok = verify(
    null,
    signedBytes(b),
    createPublicKey(key.pem),
    Buffer.from(b.signature.sig, 'base64'),
  );
  if (!ok) return fail('bad_signature', 'the signature does not match the manifest');
  return { ok: true, bundle: b, keyId: key.id };
}

export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};
