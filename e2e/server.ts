import 'dotenv/config';
import { createDb } from '@repopulse/shared';
// Imported by path, not by package name: apps/api declares no `exports` entry,
// and adding one to ship a test seam is the wrong trade — W4-00's write_scope
// is e2e/** for exactly this reason.
import { buildApp } from '../apps/api/src/app.js';
import { startFakeForge, startFakeGithub } from '@repopulse/shared';

// e2e API server (W4-00, docs/TESTING.md §6).
//
// apps/api/src/index.ts is the production entrypoint and deliberately has no
// env hook for `githubEndpoints` — pointing the shipping binary at a fake forge
// is not a capability production should have. So e2e composes its own server
// from the same `buildApp`, differing in exactly one option: the three GitHub
// URLs point at the local fake. Every plugin, guard, route and session path is
// the one that ships.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`e2e server: missing required env var ${name}`);
  return value;
}

const port = Number(process.env.E2E_API_PORT ?? 3000);
const apiBaseUrl = process.env.E2E_API_BASE_URL ?? `http://localhost:${port}`;
const webBaseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

const github = await startFakeGithub(Number(process.env.E2E_FAKE_GITHUB_PORT ?? 0));
// Data-plane fake: the connect flow and ingestion talk to this instead of
// api.github.com, so the real path runs with no credential and no network.
const forge = await startFakeForge(Number(process.env.E2E_FAKE_FORGE_PORT ?? 0));

// Real-forge smoke mode: point the SAME production buildApp at api.github.com
// instead of the fake, so a run exercises the genuine forge seam while the
// login boundary stays faked (registering an OAuth app is unrelated friction
// for what this proves). Unset in every normal run.
const forgeBaseUrl = process.env.SMOKE_FORGE_BASE_URL ?? forge.baseUrl;

const app = buildApp({
  tokenKey: Buffer.from(requireEnv('TOKEN_ENC_KEY'), 'hex'),
  webhookUrl: `${apiBaseUrl}/api/v1/webhooks/github`,
  forgeBaseUrl,
  db: createDb(requireEnv('DATABASE_URL')),
  redisUrl: requireEnv('REDIS_URL'),
  sessionSecret: requireEnv('SESSION_SECRET'),
  idleTimeoutMs: 15 * 60 * 1000,
  absoluteLifetimeMs: 12 * 60 * 60 * 1000,
  cookieSecure: false,
  githubOAuth: {
    clientId: 'e2e-client-id',
    clientSecret: 'e2e-client-secret',
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
