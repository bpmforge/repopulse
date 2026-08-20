import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { buildApp } from './app.js';
import { formatEnvProblems, validateEnv } from './routes/setup/env-registry.js';

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
const githubClientId = requireEnv('GITHUB_APP_CLIENT_ID');
const githubClientSecret = requireEnv('GITHUB_APP_CLIENT_SECRET');

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
  idleTimeoutMs: 15 * 60 * 1000,
  absoluteLifetimeMs: 12 * 60 * 60 * 1000,
  cookieSecure: process.env.NODE_ENV === 'production',
  githubOAuth: {
    clientId: githubClientId,
    clientSecret: githubClientSecret,
    redirectUri: `${apiBaseUrl}/auth/callback`,
  },
  loginRedirectUrl: `${publicBaseUrl}/`,
});

// 3300, not 3000: 3000 is what every Node project defaults to, and sharing a
// machine with one more of them is enough to lose an afternoon. See
// ports.config.mjs — this literal is the same block, spelled here because the
// shipped container must not import a dev-tooling file.
const port = Number(process.env.PORT ?? 3300);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exitCode = 1;
});
