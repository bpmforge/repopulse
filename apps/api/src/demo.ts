import 'dotenv/config';
import { createDb, seedWarehouse, startFakeForge, startFakeGithub } from '@repopulse/shared';
import { buildApp } from './app.js';
import { local } from '@repopulse/auth';
import { assertDemoAllowed, demoRequested, DEMO_ACCOUNT } from './lib/demo.js';

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

const github = await startFakeGithub(Number(process.env.DEMO_GITHUB_PORT ?? 0));
const forge = await startFakeForge(Number(process.env.DEMO_FORGE_PORT ?? 0));

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
