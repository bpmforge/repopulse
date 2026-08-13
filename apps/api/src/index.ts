import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { buildApp } from './app.js';

function requireEnv(name: string): string {
  const value = process.env[name];
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

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exitCode = 1;
});
