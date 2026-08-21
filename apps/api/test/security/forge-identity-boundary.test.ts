import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// NO ROUTE OUTSIDE THE AUTH MODULE MAY ASSUME A FORGE IDENTITY (W15-05, D14).
//
// Before D14 the two were the same thing: you signed in with GitHub, so the
// session subject WAS a forge account and `users.forge_user_id` was populated
// for everyone. Code written under that assumption is still correct-looking
// today and silently wrong: a local or OIDC user has no forge account, and a
// handler that reaches for one gets null. The failure is not a crash — it is a
// personalized screen quietly showing zero, or a 401 that reads as "your
// session expired" to someone who just signed in successfully.
//
// The auth module is the ONE place allowed to know about forge identities: it
// is where a GitHub login is exchanged for a user, and `identityLinkState` is
// its answer to "is this person linked to a committer, and if not, why not".
// Every other route works from `userId` and asks that module.
//
// This is a grep gate rather than a type: the session store is a string-keyed
// bag, so `session.get('forgeLogin')` type-checks perfectly and would ship.

const repoRoot = new URL('../../../../', import.meta.url).pathname;

/**
 * Every shipped route file OUTSIDE the auth module.
 *
 * The excludes are spelled out in full rather than as `**\/*.test.ts`, because
 * an unanchored exclude combined with a deep positive pathspec makes git return
 * NOTHING AT ALL — verified by running it — and a gate that scans zero files
 * passes forever. `scannedFiles` is asserted below for exactly that reason.
 */
const ROUTE_PATHSPEC = [
  'apps/api/src/routes',
  ':(exclude)apps/api/src/routes/auth/**',
  ':(exclude)apps/api/src/routes/**/*.test.ts',
  ':(exclude)apps/api/src/routes/*.test.ts',
];

function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // `git grep` exits 1 when it matches nothing, which for this gate is the
    // expected outcome and not an error.
    if ((error as { status?: number }).status === 1) return '';
    throw error;
  }
}

function scannedFiles(): string[] {
  return git(['ls-files', '--', ...ROUTE_PATHSPEC])
    .split('\n')
    .filter(Boolean);
}

/** Every key read from or written to the session in the given scope. */
function sessionKeys(pathspec: string[]): string[] {
  const matches = git([
    'grep',
    '-hoE',
    String.raw`session\??\.(get|set)\('[A-Za-z0-9_]+'`,
    '--',
    ...pathspec,
  ]);
  const keys = new Set<string>();
  for (const line of matches.split('\n')) {
    const key = /'([A-Za-z0-9_]+)'/.exec(line)?.[1];
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

const FORGE_IDENTITY_PATTERN = 'forgeUserId|forge_user_id';

function forgeIdentityHits(pathspec: string[]): string[] {
  return git(['grep', '-nE', FORGE_IDENTITY_PATTERN, '--', ...pathspec])
    .split('\n')
    .filter(Boolean);
}

/**
 * What a session may legitimately carry outside the auth module.
 *
 * An allowlist, not a list of banned names: a blacklist only catches the names
 * we thought of, and the next author to reintroduce this coupling will spell it
 * however their feature reads best.
 */
const ALLOWED_SESSION_KEYS = new Set([
  // The one durable fact: which USER is signed in, by our id, regardless of
  // which of the three doors they came through.
  'userId',
  // Session age, used by the idle/absolute lifetime checks.
  'createdAt',
]);

describe('the forge-identity boundary is real, and this gate can see it', () => {
  // ANTI-VACUITY, part one: the pathspec selects files. Without this, a typo in
  // an exclude turns every assertion below into a tautology over an empty set.
  it('scans the route tree it claims to scan', () => {
    const files = scannedFiles();

    expect(files).toContain('apps/api/src/routes/me/index.ts');
    expect(files).toContain('apps/api/src/routes/admin/index.ts');
    // A floor, not an exact count — routes are added constantly. It is low
    // enough never to need touching and high enough that a broken pathspec
    // returning a handful of files still fails.
    expect(files.length).toBeGreaterThan(20);
    // The excludes did what they say: nothing from the auth module, no tests.
    expect(files.filter((file) => file.includes('/routes/auth/'))).toEqual([]);
    expect(files.filter((file) => file.endsWith('.test.ts'))).toEqual([]);
  });

  // ANTI-VACUITY, part two: the patterns match real code when real code is
  // there. Both controls point at STATEMENTS, never at prose — a control aimed
  // at a comment proves the grep can find English and breaks on a reword.
  it('the session-key extractor finds keys that exist (control)', () => {
    // local.ts:~111 does `request.session.set('pendingPasswordChangeUserId', ...)`
    // in the forced-password-change branch.
    const keys = sessionKeys(['apps/api/src/routes/auth/local.ts']);

    expect(keys).toContain('pendingPasswordChangeUserId');
    expect(keys).toContain('userId');
    // Closes the loop without editing a file another agent may be holding: the
    // extractor finds this key, and the allowlist would reject it, so the real
    // assertion below demonstrably goes red the day one appears in its scope.
    expect(ALLOWED_SESSION_KEYS.has('pendingPasswordChangeUserId')).toBe(false);
  });

  it('the forge-identity pattern finds forge identities that exist (control)', () => {
    // resolve.ts reads `core.users.forgeUserId` to link a signed-in user to a
    // committer — the legitimate version of what this gate forbids elsewhere.
    const hits = forgeIdentityHits(['packages/auth/src/identity/resolve.ts']);

    expect(hits.length).toBeGreaterThan(0);
  });

  it('no route outside the auth module reads anything but the signed-in user id', () => {
    const unexpected = sessionKeys(ROUTE_PATHSPEC).filter((key) => !ALLOWED_SESSION_KEYS.has(key));

    expect(
      unexpected,
      'a route is putting something other than our own user id on the session — since D14 the ' +
        'signed-in person may have no forge account at all, so anything forge-shaped here is ' +
        'null for local and OIDC users. Ask @repopulse/auth (identityLinkState) instead.',
    ).toEqual([]);
  });

  it('no route outside the auth module touches a forge user id', () => {
    const hits = forgeIdentityHits(ROUTE_PATHSPEC);

    expect(
      hits,
      "forge_user_id is the auth module's business. A route that reads it assumes the person " +
        'signed in through a forge, which since D14 is one of three doors.',
    ).toEqual([]);
  });
});
