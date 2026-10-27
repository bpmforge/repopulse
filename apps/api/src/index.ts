import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { buildApp } from './app.js';
import { admission, local, oidc } from '@repopulse/auth';
import { formatEnvProblems, validateEnv } from './routes/setup/env-registry.js';
import { listenHost } from './lib/listen-host.js';
import { parseTrustProxy } from './lib/trust-proxy.js';
import { outboundProxyNotice } from './lib/outbound-proxy.js';
import { sessionLifetime } from './lib/session-lifetime.js';

// W11-02, acceptance 4: wrong or missing config fails HERE, with a message
// naming every variable at fault — not a stack trace, and not a half-booted
// app serving errors from a screen the operator has to guess their way to.
//
// EVERY problem at once, deliberately: filling in a .env one restart per
// variable is a bad first hour with a product, and the customer is doing it on
// their own machine where we cannot see what they typed.
const envProblems = validateEnv(process.env, ['api', 'shared']);
if (envProblems.length > 0) {
  console.error(formatEnvProblems(envProblems));
  process.exit(1);
}

// W20-07 (UX_TODO INS-55). Validated by the env registry above, so the error
// branch is unreachable unless the two drift — in which case, fail loudly.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (typeof trustProxy === 'object') {
  console.error(`TRUST_PROXY ${trustProxy.error}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  // Unreachable after validateEnv above; kept so this file still fails loudly
  // rather than passing `undefined` on if the registry and the reads drift.
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

const databaseUrl = requireEnv('DATABASE_URL');
const redisUrl = requireEnv('REDIS_URL');
const sessionSecret = requireEnv('SESSION_SECRET');
const apiBaseUrl = requireEnv('API_BASE_URL');
const publicBaseUrl = requireEnv('PUBLIC_BASE_URL');
// NOT requireEnv any more (W15-02, D14). Demanding a GitHub App to start is
// exactly what made this product un-installable without one: a customer could
// not even reach the screen that connects their own Gitea organisation. When
// both are absent, forge sign-in is simply not offered.
const githubClientId = process.env.GITHUB_APP_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_APP_CLIENT_SECRET;

const app = buildApp({
  // Real AES key, validated at boot: loadTokenKey throws unless TOKEN_ENC_KEY is
  // 32 bytes of hex, so a misconfigured install fails immediately instead of
  // silently writing credentials it can never decrypt.
  tokenKey: credentials.loadTokenKey(),
  webhookUrl: `${publicBaseUrl}/api/v1/webhooks/github`,
  ...(process.env.FORGE_BASE_URL ? { forgeBaseUrl: process.env.FORGE_BASE_URL } : {}),
  db: createDb(databaseUrl),
  redisUrl,
  sessionSecret,
  ...sessionLifetime(process.env),
  cookieSecure: process.env.NODE_ENV === 'production',
  trustProxy,
  ...(githubClientId && githubClientSecret
    ? {
        githubOAuth: {
          clientId: githubClientId,
          clientSecret: githubClientSecret,
          redirectUri: `${apiBaseUrl}/auth/callback`,
        },
      }
    : {}),
  loginRedirectUrl: `${publicBaseUrl}/`,
  // W20-10 (UX_TODO INS-50): SSO_ALLOWED_* — empty means anyone may join, as before.
  admission: admission.admissionPolicyFromEnv(process.env),
  // Throws here if OIDC is half-configured — deliberately, because the
  // alternative is discovering it at the callback, after a user has already
  // authenticated with their IdP.
  ...(oidc.oidcConfigFromEnv(process.env) ? { oidc: oidc.oidcConfigFromEnv(process.env)! } : {}),
});

// The first admin (W15-02, D14). Runs on every boot and is idempotent: it
// creates the account only when no local account with a password exists, and
// never overwrites a password that has since been changed. Without this call
// a fresh install has no way in at all — which is the whole point of D14.
const bootstrap = await local.ensureBootstrapAdmin(createDb(databaseUrl), {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
});
app.log.info({ bootstrap: bootstrap.status }, 'local admin bootstrap');

// W20-10 (UX_TODO INS-63): a proxy Node's fetch would silently ignore is said
// here, not discovered later as a forge connection that times out.
const proxyNotice = outboundProxyNotice(process.env);
if (proxyNotice) app.log[proxyNotice.level](proxyNotice.message);

// 3300, not 3000: 3000 is what every Node project defaults to, and sharing a
// machine with one more of them is enough to lose an afternoon. See
// ports.config.mjs — this literal is the same block, spelled here because the
// shipped container must not import a dev-tooling file.
const port = Number(process.env.PORT ?? 3300);

app.listen({ port, host: listenHost() }).catch((err) => {
  app.log.error(err);
  process.exitCode = 1;
});
