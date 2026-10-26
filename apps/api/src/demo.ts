import 'dotenv/config';
import {
  DEMO_LOGIN,
  FAKE_TOKEN,
  core,
  createDb,
  seedWarehouse,
  startFakeForge,
  startFakeGithub,
} from '@repopulse/shared';
import { buildApp } from './app.js';
import { and, eq } from 'drizzle-orm';
import { credentials, local, workspace as workspaceModule } from '@repopulse/auth';
import { assertDemoAllowed, demoRequested, DEMO_ACCOUNT } from './lib/demo.js';
import { computeDemoSnapshots } from './lib/demo-snapshots.js';

// Demo entrypoint (W13-02): the whole product, no GitHub account required.
//
// A SEPARATE entrypoint from src/index.ts, deliberately. The production binary
// has no env hook for `githubEndpoints` or a fake forge, and e2e/server.ts
// already documents why: pointing the shipping binary at a fake forge is not a
// capability production should have. Adding a DEMO_MODE branch to index.ts
// would create exactly that capability and put it one environment variable
// away. So demo mode composes its own server from the same `buildApp`, and
// every plugin, guard, route and session path below is the one that ships.
//
// What differs from production, and nothing else:
//   - the three GitHub OAuth URLs point at a local fake (no OAuth app to register)
//   - the forge base URL points at a local fake (no credential, no network)
//   - the warehouse is seeded, so the screens have something to show

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `demo: missing required env var ${name} — run \`pnpm bootstrap\` first (it generates the secrets and seeds the database).`,
    );
  }
  return value;
}

// BEFORE anything binds a port or starts a fake. The refusal is the security
// control (see lib/demo.ts) and it fails closed.
assertDemoAllowed(process.env);
if (!demoRequested(process.env)) {
  console.error('demo: DEMO_MODE is not set. Run `DEMO_MODE=1 pnpm dev`.');
  process.exit(1);
}

// 3300 — the same block as the API's own default (ports.config.mjs). Demo
// mode had its own 3000 literal, so `pnpm dev` moved the real API and left the
// demo one on the port another project was already using.
const port = Number(process.env.PORT ?? 3300);
// Derived from PORT, NOT from API_BASE_URL. The OAuth redirect_uri is built
// from this, and .env ships API_BASE_URL=http://localhost:3000 — so running
// the demo on any other port sent the callback to whatever was listening on
// 3000 instead of to this server. That failed as a 307 to /login with no
// session cookie: a login that appears to do nothing, with nothing in the log
// to say why. Demo mode is local by definition, so the port it actually bound
// is the only honest answer here.
const apiBaseUrl = `http://localhost:${port}`;
const webBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5273';

const db = createDb(requireEnv('DATABASE_URL'));

// Seeded every boot. Demo mode is meant to be disposable — a run that showed
// empty screens because the database had been reset would read as "the product
// is broken", which is the opposite of what a demo is for. seedWarehouse is
// idempotent by fixture id.
const seeded = await seedWarehouse(db);
// W21-01: the newest snapshots come from the seeded facts (lib/demo-snapshots),
// so a preset window and a custom range over the same days agree.
await computeDemoSnapshots(db, seeded.workspaceId, seeded.repoIds);

// W16-02 (F1). A REAL local account, so the email/password form the sign-in
// screen puts first actually works in demo mode. `createLocalUser` returns
// `exists` on a re-run, which is the desired no-op — demo mode reseeds every
// boot and must not fail because it already did this once.
const demoAccount = await local.createLocalUser(db, {
  email: DEMO_ACCOUNT.email,
  password: DEMO_ACCOUNT.password,
  name: 'Demo user',
  // Not `true`: a forced password change is right for an admin-created account
  // whose password someone else typed, and wrong for a credential printed on
  // the screen the person is looking at. Making the demo's first act a password
  // change would be a worse first run than the bug this fixes.
  mustChangePassword: false,
});
if (!demoAccount.ok && demoAccount.reason !== 'exists') {
  throw new Error(`demo: could not create the demo account (${demoAccount.reason})`);
}

// ADMIN, deliberately.
//
// `ensureMembership` makes the first member of a workspace an admin and
// everyone after that a member (FR-AUTH-3). The seeded fixture user is already
// in the demo workspace, so the demo account arrives second and lands as a
// plain member — and every Admin screen 403s. Connections, Sync, Members,
// Rules, Analysis and Models are a large part of what there is to look at, so a
// demo that cannot reach them is showing half the product while claiming to
// show all of it.
//
// Safe for the same single reason every other demo shortcut is: demo mode
// refuses to boot under NODE_ENV=production.
{
  const [row] = await db
    .select({ id: core.users.id })
    .from(core.users)
    .where(eq(core.users.authSubject, DEMO_ACCOUNT.email))
    .limit(1);
  if (row) {
    const membership = await workspaceModule.ensureMembership(db, row.id);
    if (membership.role !== 'admin') {
      await db
        .update(core.workspaceMembers)
        .set({ role: 'admin' })
        .where(
          and(
            eq(core.workspaceMembers.workspaceId, membership.workspace.id),
            eq(core.workspaceMembers.userId, row.id),
          ),
        );
    }

    // A COMMITTER IDENTITY, so My Focus has something in it (W16-13).
    //
    // resolveUserIdentity matches users.forge_user_id against
    // identities.forge_user_id; a local account has neither, so every personal
    // view was honestly empty and the shell showed the unlinked-identity
    // banner. That banner is correct behaviour and exactly what
    // identityLinkState exists for — it is just the wrong thing for a demo,
    // whose whole job is to leave nothing empty.
    //
    // Its OWN identity (DEMO_LOGIN), not a share of the fixture's:
    // users.forge_user_id is UNIQUE, so claiming FIXTURE_LOGIN here would take
    // it from the mocked-OAuth path — and the README advertises both sign-in
    // doors, so whichever lost it would be the one that lands on an empty
    // screen. The seeder makes DEMO_LOGIN a full contributor, so the demo
    // account authors PRs, reviews others' and appears in the ownership data.
    await db.update(core.users).set({ forgeUserId: DEMO_LOGIN }).where(eq(core.users.id, row.id));
    await db
      .update(core.identities)
      .set({ userId: row.id })
      .where(
        and(
          eq(core.identities.workspaceId, membership.workspace.id),
          eq(core.identities.forgeUserId, DEMO_LOGIN),
        ),
      );
  }
}

const github = await startFakeGithub(Number(process.env.DEMO_GITHUB_PORT ?? 0));
// STARTED BEFORE THE CONNECTION IS FIXED UP, because the row needs its address.
const forge = await startFakeForge(Number(process.env.DEMO_FORGE_PORT ?? 0));

// A USABLE forge connection for the seeded workspace (W16-28, W16-29).
//
// The seeder writes `credentialCiphertext: Buffer.from('seed')` — four bytes,
// not an AES-GCM blob — because packages/shared cannot depend on packages/auth
// and so has no vault to encrypt with. Harmless for every screen that only
// reads the warehouse, and fatal for anything that actually calls the forge:
// every secrets scan died with "ciphertext too short", left no scan_run, and
// the Security tab went on reporting "has never run".
//
// Re-sealed here, where the vault IS available, and pointed at the fake forge
// that is now listening, so the demo can demonstrate the scanning path rather
// than only the dashboards.
{
  const key = Buffer.from(requireEnv('TOKEN_ENC_KEY'), 'hex');
  // THE FAKE FORGE'S OWN TOKEN, not a plausible-looking string. It checks the
  // Authorization header rather than accepting anything — a fake that ignored
  // auth would prove nothing about credential handling — so any other value
  // gets a 401, which is what "Anti-slop · last run failed · archive request
  // returned 401" was on the Security tab.
  const sealed = credentials.encryptCredential(FAKE_TOKEN, key);
  await db
    .update(core.forgeConnections)
    .set({
      credentialCiphertext: sealed.ciphertext,
      credentialIv: sealed.iv,
      keyVersion: sealed.keyVersion,
      credentialFingerprint: sealed.fingerprint,
      // THE ROW, not just the worker's env (W16-29). providerForRepo reads
      // `conn.baseUrl ?? FORGE_BASE_URL ?? api.github.com` and lazily BACKFILLS
      // the row with whatever it resolved — so one boot without the env var
      // stamped api.github.com onto the connection permanently, and every later
      // boot sent the demo's fake token to the real GitHub however the env was
      // set. Writing the address here is what makes that unreachable.
      baseUrl: forge.baseUrl,
    })
    .where(eq(core.forgeConnections.workspaceId, seeded.workspaceId));
}

const app = buildApp({
  db,
  demo: true,
  demoAccount: DEMO_ACCOUNT,
  tokenKey: Buffer.from(requireEnv('TOKEN_ENC_KEY'), 'hex'),
  webhookUrl: `${apiBaseUrl}/api/v1/webhooks/github`,
  forgeBaseUrl: forge.baseUrl,
  redisUrl: requireEnv('REDIS_URL'),
  sessionSecret: requireEnv('SESSION_SECRET'),
  idleTimeoutMs: 15 * 60 * 1000,
  absoluteLifetimeMs: 12 * 60 * 60 * 1000,
  cookieSecure: false,
  githubOAuth: {
    clientId: 'demo-client-id',
    clientSecret: 'demo-client-secret',
    redirectUri: `${apiBaseUrl}/auth/callback`,
  },
  githubEndpoints: {
    authorizeUrl: `${github.baseUrl}/login/oauth/authorize`,
    tokenUrl: `${github.baseUrl}/login/oauth/access_token`,
    userUrl: `${github.baseUrl}/user`,
  },
  loginRedirectUrl: `${webBaseUrl}/`,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => github.close())
      .then(() => forge.close());
  });
}

await app.listen({ port, host: '127.0.0.1' });
console.log(
  `\n  DEMO MODE — fake forge, mocked login, seeded warehouse\n` +
    `  ${JSON.stringify(seeded.counts)}\n` +
    `  Sign in at ${webBaseUrl}\n` +
    `    email     ${DEMO_ACCOUNT.email}\n` +
    `    password  ${DEMO_ACCOUNT.password}\n` +
    `  or click "Sign in with GitHub" — the OAuth boundary is mocked.\n`,
);
