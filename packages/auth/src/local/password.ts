import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Password hashing for local accounts (W15-02, D14).
//
// Node's built-in scrypt, and nothing else. D10 makes this product proprietary
// and redistributable, so every dependency is a licence question we have to
// answer for a customer; argon2 and bcrypt also drag a native build into an
// image that has to work on two architectures. scrypt is memory-hard, it is in
// the standard library, and it has no licence, no build step and no CVE feed of
// its own.

/**
 * The cost parameters a NEW hash is written with. Old hashes carry their own
 * (see the stored format below) and are verified with theirs, so raising these
 * is a one-line change that migrates people on their next successful login
 * rather than locking everybody out.
 *
 * N = 2^15. scrypt's own published defaults (N = 2^14 for interactive use, and
 * OpenSSL's N = 16384) are aimed at 2009-era hardware; 2^15 with r = 8 is the
 * commonly cited modern floor for password storage (OWASP's cheat sheet gives
 * N = 2^17/r = 8/p = 1 as its first choice and N = 2^15 as an accepted
 * alternative when memory is tight). Measured on the dev M2: ~42 ms per
 * derivation, which is the real constraint — this runs on every login attempt
 * and every attempt is a chance for someone to make the API do work for free.
 */
const CURRENT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 } as const;

const SALT_BYTES = 16;

/**
 * scrypt needs 128 * N * r bytes, which at N = 2^15 and r = 8 is 33.5 MB —
 * OVER node's 32 MB default `maxmem`, so the derivation throws
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS unless this is raised. Verified against the
 * real runtime rather than assumed: N = 32768 with default maxmem fails.
 * Derived from the stored parameters, not fixed, so verifying an old hash asks
 * for exactly the memory that hash needs.
 */
function maxmemFor(N: number, r: number): number {
  return 256 * N * r;
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      // Normalised so that a password typed on a Mac and the same password
      // typed on Linux hash identically — the two platforms disagree about the
      // Unicode composition of accented characters, and a user locked out by
      // that would have no way to discover why.
      password.normalize('NFKC'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params.N, params.r) },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/**
 * `scrypt$N=32768,r=8,p=1,keylen=32$<salt base64>$<hash base64>`
 *
 * The parameters live IN the string on purpose. A bare hash with the cost
 * baked into the code is a hash that can never be migrated: the day you raise
 * N, every existing row becomes unverifiable and the only recovery is a
 * password reset for the whole install.
 */
function encode(params: ScryptParams, salt: Buffer, hash: Buffer): string {
  const meta = `N=${params.N},r=${params.r},p=${params.p},keylen=${params.keylen}`;
  return `scrypt$${meta}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 4) return null;
  const [scheme, meta, saltB64, hashB64] = parts as [string, string, string, string];
  if (scheme !== 'scrypt') return null;

  const numbers: Record<string, number> = {};
  for (const pair of meta.split(',')) {
    const [key, value] = pair.split('=');
    if (!key || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    numbers[key] = parsed;
  }
  const { N, r, p, keylen } = numbers;
  if (N === undefined || r === undefined || p === undefined || keylen === undefined) return null;

  // A stored record could in principle name a cost we refuse to spend. Bound it
  // rather than letting a single row turn one login into a gigabyte of
  // allocation — a hash that asks for more than this is corrupt, not old.
  if (N > 2 ** 20 || r > 32 || p > 16 || keylen > 128) return null;

  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || hash.length !== keylen) return null;
  return { params: { N, r, p, keylen }, salt, hash };
}

/** Hashes a password with the CURRENT parameters, for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, CURRENT_PARAMS);
  return encode(CURRENT_PARAMS, salt, hash);
}

export interface VerifyResult {
  ok: boolean;
  /**
   * True when the password was right but the stored hash uses weaker
   * parameters than we write today. Storing the parameters lets us READ an old
   * hash; rehashing on a successful login is what actually migrates it, and
   * login is the only moment the plaintext exists to rehash from.
   */
  needsRehash: boolean;
}

/**
 * Verifies a password against a stored hash, in constant time with respect to
 * the hash contents.
 *
 * Uses the parameters recorded in the stored string, not the current ones —
 * otherwise writing them down bought nothing.
 */
export async function verifyPassword(stored: string, password: string): Promise<VerifyResult> {
  const parsed = parse(stored);
  // A record we cannot parse still costs a derivation before it answers, so a
  // corrupt row is not distinguishable from a wrong password by timing either.
  if (!parsed) {
    await derive(password, randomBytes(SALT_BYTES), CURRENT_PARAMS);
    return { ok: false, needsRehash: false };
  }

  const candidate = await derive(password, parsed.salt, parsed.params);
  // Lengths match by construction (parse() rejects a hash whose length differs
  // from its own keylen, and we derived at that keylen), which matters because
  // timingSafeEqual THROWS on a length mismatch rather than returning false.
  const ok = candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  return { ok, needsRehash: ok && isWeakerThanCurrent(parsed.params) };
}

function isWeakerThanCurrent(params: ScryptParams): boolean {
  return (
    params.N < CURRENT_PARAMS.N ||
    params.r < CURRENT_PARAMS.r ||
    params.p < CURRENT_PARAMS.p ||
    params.keylen < CURRENT_PARAMS.keylen
  );
}

// A real hash of a value nobody knows, used to spend the SAME derivation on a
// login for an address that has no local password as on one that does. Without
// it, "no such user" returns in microseconds and "wrong password" in ~42 ms,
// which is a remotely readable oracle for which email addresses have accounts
// here. Computed once, lazily, so importing this module costs nothing.
let decoyHash: Promise<string> | undefined;
export function decoyPasswordHash(): Promise<string> {
  return (decoyHash ??= hashPassword(randomBytes(32).toString('base64')));
}

/**
 * The minimum we will accept for a stored password.
 *
 * Length only, deliberately: composition rules ("one symbol, one digit") are
 * known to push people towards predictable substitutions, and NIST SP 800-63B
 * dropped them. 12 is that document's floor for a human-chosen secret.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordPolicyError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  // NIST's other length bound. scrypt itself has no practical input limit, but
  // an unbounded field means an attacker can post a megabyte and make us hash
  // it; 256 is far past any real passphrase.
  if (password.length > 256) return 'Password must be at most 256 characters';
  return null;
}
