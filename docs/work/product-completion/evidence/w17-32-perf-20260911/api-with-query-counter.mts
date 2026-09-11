// W17-32: the e2e API (a copy of e2e/server.ts's wiring) with ONE addition —
// the postgres.js `debug` hook counts every statement the process sends, and a
// side port reports the running total. measure.mts reads it before and after a
// single request, which gives an exact per-request query count with no
// dependency on Postgres logging (journald rate-limits the burst a 700-query
// request produces and silently drops lines).
//
//   E2E_API_PORT=3310 E2E_FAKE_FORGE_PORT=9099 pnpm exec tsx \
//     docs/work/product-completion/evidence/w17-32-perf-20260911/api-with-query-counter.mts
import 'dotenv/config';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { drizzle } from 'drizzle-orm/postgres-js';
import { core, facts, plans, read, security, startFakeForge, startFakeGithub } from '@repopulse/shared';
import { buildApp } from '../../../../../apps/api/src/app.js';
import { PORTS } from '../../../../../ports.config.mjs';

const require = createRequire(new URL('../../../../../packages/shared/package.json', import.meta.url));
const postgres = require('postgres') as typeof import('postgres').default;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

let statements = 0;
const client = postgres(requireEnv('DATABASE_URL'), {
  onnotice: () => {},
  debug: () => {
    statements++;
  },
});
const db = drizzle(client, { schema: { ...core, ...facts, ...read, ...plans, ...security } });

const COUNTER_PORT = Number(process.env.QUERY_COUNTER_PORT ?? 3312);
createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ statements }));
}).listen(COUNTER_PORT, '127.0.0.1');

const port = Number(process.env.E2E_API_PORT ?? PORTS.e2eApi);
const apiBaseUrl = `http://localhost:${port}`;
const webBaseUrl = `http://localhost:${PORTS.web}`;
const github = await startFakeGithub(0);
const forge = await startFakeForge(Number(process.env.E2E_FAKE_FORGE_PORT ?? 0));

const app = buildApp({
  tokenKey: Buffer.from(requireEnv('TOKEN_ENC_KEY'), 'hex'),
  webhookUrl: `${apiBaseUrl}/api/v1/webhooks/github`,
  forgeBaseUrl: forge.baseUrl,
  db: db as unknown as Parameters<typeof buildApp>[0]['db'],
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

await app.listen({ port, host: '127.0.0.1' });
console.log(`api on ${apiBaseUrl}, query counter on http://127.0.0.1:${COUNTER_PORT}`);
