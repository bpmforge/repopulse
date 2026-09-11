// W17-32 measurement harness. Repeats every measurement (API: 2 warm-up + 10
// timed requests; browser: 5 fresh-context page loads) and writes the raw
// samples plus p50/p95 to <label>.json beside this file. Nothing is asserted
// here — the reading lives in the evidence markdown.
//
// Stack expected (the e2e stack, no worker): e2e/server.ts on E2E_API_PORT and
// the Vite dev server on PORTS.web proxying to it. Sign-in goes through the
// mocked OAuth boundary exactly as e2e/global-setup.ts does.
//
//   pnpm exec tsx docs/work/product-completion/evidence/w17-32-perf-20260911/measure.mts <label>
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request as pwRequest } from '@playwright/test';
import { createDb } from '@repopulse/shared';
import { sql } from 'drizzle-orm';
import { PORTS } from '../../../../../ports.config.mjs';

const label = process.argv[2];
if (!label) throw new Error('usage: measure.mts <label>');
const here = dirname(fileURLToPath(import.meta.url));
const WEB = `http://localhost:${PORTS.web}`;
const API = `http://localhost:${PORTS.e2eApi}`;
const API_RUNS = 10;
const API_WARMUP = 2;
const PAGE_RUNS = 5;

const db = createDb(process.env.DATABASE_URL!);
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

// Query count per request, read from api-with-query-counter.mts's side port:
// the postgres.js debug hook in that process counts every statement sent.
// pg_stat_statements is not loaded on this Postgres, pg_stat_user_tables
// undercounts (a pooled backend flushes only at its next transaction end), and
// statement logging through journald drops lines under a 700-query burst.
const COUNTER = `http://127.0.0.1:${process.env.QUERY_COUNTER_PORT ?? 3312}`;
async function statements(): Promise<number> {
  const res = await fetch(COUNTER);
  return ((await res.json()) as { statements: number }).statements;
}
const settle = () => new Promise((r) => setTimeout(r, 1500));

// 1. Sign in once, the way the e2e suite does.
const browser = await chromium.launch();
const loginCtx = await browser.newContext({ baseURL: WEB });
const loginPage = await loginCtx.newPage();
await loginPage.goto('/auth/login');
await loginPage.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 15_000 });
const storageState = await loginCtx.storageState();
await loginCtx.close();

const dataset = (
  await db.execute<{ repos: string; findings: string; snapshots: string }>(sql`select
    (select count(*) from repos) repos,
    (select count(*) from findings) findings,
    (select count(*) from metric_snapshots) snapshots`)
)[0]!;

// 2. API endpoints: latency, payload size, and SQL query count for ONE request.
const api = await pwRequest.newContext({ baseURL: API, storageState });
const ENDPOINTS = [
  '/api/v1/repos?window=30d',
  '/api/v1/org/health-tiles?window=30d',
  '/api/v1/org/attention?window=30d',
  '/api/v1/org/summary?window=30d',
  '/api/v1/findings',
  '/api/v1/findings?sort=severity',
  '/api/v1/findings?status=open&dimension=security',
  '/api/v1/findings/stats',
];
const apiResults: Record<string, unknown>[] = [];
for (const path of ENDPOINTS) {
  for (let i = 0; i < API_WARMUP; i++) await (await api.get(path)).body();
  await settle();
  const before = await statements();
  const single = await api.get(path);
  const bytes = (await single.body()).byteLength;
  const queries = (await statements()) - before;
  const ms: number[] = [];
  let items = -1;
  for (let i = 0; i < API_RUNS; i++) {
    const t0 = performance.now();
    const res = await api.get(path);
    const body = await res.body();
    ms.push(performance.now() - t0);
    if (res.status() !== 200) throw new Error(`${path} -> ${res.status()}`);
    if (items < 0) {
      const json = JSON.parse(body.toString()) as { items?: unknown[] };
      items = Array.isArray(json.items) ? json.items.length : -1;
    }
  }
  const row = {
    path,
    status: single.status(),
    bytes,
    items,
    p50_ms: +pct(ms, 50).toFixed(1),
    p95_ms: +pct(ms, 95).toFixed(1),
    max_ms: +Math.max(...ms).toFixed(1),
    samples_ms: ms.map((m) => +m.toFixed(1)),
    sql_queries_one_request: queries,
  };
  apiResults.push(row);
  console.log(`${path}  p50 ${row.p50_ms}ms  p95 ${row.p95_ms}ms  ${bytes} B  items ${items}  queries ${queries}`);
}

// 3. Findings keyset paging integrity under both sorts: walk every page and
// compare what came back with what the table holds.
const total = Number(
  (await db.execute<{ n: string }>(sql`select count(*)::text n from findings where workspace_id =
    (select id from workspaces where slug = 'default')`))[0]!.n,
);
const paging: Record<string, unknown>[] = [];
for (const sort of ['risk', 'severity']) {
  const seen = new Map<number, number>();
  let cursor: string | null = null;
  let pages = 0;
  let maxItems = 0;
  const t0 = performance.now();
  do {
    const url = `/api/v1/findings?sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api.get(url);
    const json = (await res.json()) as { items: { id: number }[]; next_cursor: string | null };
    pages++;
    maxItems = Math.max(maxItems, json.items.length);
    for (const f of json.items) seen.set(f.id, (seen.get(f.id) ?? 0) + 1);
    cursor = json.next_cursor;
    if (pages > 1000) throw new Error('paging did not terminate');
  } while (cursor);
  const duplicates = [...seen.values()].filter((n) => n > 1).length;
  const row = {
    sort,
    pages,
    max_page_items: maxItems,
    distinct_ids: seen.size,
    duplicate_ids: duplicates,
    table_rows: total,
    missing: total - seen.size,
    walk_ms: +(performance.now() - t0).toFixed(0),
  };
  paging.push(row);
  console.log(`paging sort=${sort}: ${JSON.stringify(row)}`);
}
await api.dispose();

// 4. Browser page loads: fresh context per run (cold module/query cache in the
// SPA, warm Vite dev server), time from navigation to network idle, and the
// number and size of /api/ responses the page needed.
const firstRepo = (await db.execute<{ id: string }>(sql`select min(id)::text id from repos where org = 'acme'`))[0]!.id;
const PAGES = ['/', '/repos', '/findings', `/repos/${firstRepo}?window=30d`];
const pageResults: Record<string, unknown>[] = [];
for (const path of PAGES) {
  const wall: number[] = [];
  const dcl: number[] = [];
  const apiCounts: number[] = [];
  const apiBytes: number[] = [];
  for (let i = 0; i < PAGE_RUNS; i++) {
    const ctx = await browser.newContext({ baseURL: WEB, storageState });
    const page = await ctx.newPage();
    let count = 0;
    let bytes = 0;
    let last = performance.now();
    page.on('response', (res) => {
      // The overview opens an SSE stream on /events that never goes idle;
      // it is a subscription, not a load-time request.
      if (!res.url().includes('/api/v1/') || res.url().includes('/events')) return;
      count++;
      last = performance.now();
      void res.body().then((b) => (bytes += b.byteLength)).catch(() => {});
    });
    const t0 = performance.now();
    await page.goto(path, { waitUntil: 'load' });
    // "Loaded" = no new API response for 1s (the widgets fetch independently).
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      if (performance.now() - last > 1000) break;
      if (performance.now() - t0 > 20_000) break;
    }
    wall.push(last - t0);
    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return e ? e.domContentLoadedEventEnd : -1;
    });
    dcl.push(nav);
    await new Promise((r) => setTimeout(r, 200));
    apiCounts.push(count);
    apiBytes.push(bytes);
    await ctx.close();
  }
  const row = {
    path,
    runs: PAGE_RUNS,
    to_last_api_response_p50_ms: +pct(wall, 50).toFixed(0),
    to_last_api_response_max_ms: +Math.max(...wall).toFixed(0),
    samples_ms: wall.map((m) => +m.toFixed(0)),
    dom_content_loaded_p50_ms: +pct(dcl, 50).toFixed(0),
    api_requests: apiCounts,
    api_bytes: apiBytes,
  };
  pageResults.push(row);
  console.log(`${path}  idle p50 ${row.to_last_api_response_p50_ms}ms  max ${row.to_last_api_response_max_ms}ms  api reqs ${apiCounts.join('/')}  bytes ${apiBytes.join('/')}`);
}
await browser.close();
await db.$client.end();

const out = {
  label,
  at: new Date().toISOString(),
  host: `${process.platform} ${process.arch} node ${process.version}`,
  dataset,
  api: apiResults,
  paging,
  pages: pageResults,
};
writeFileSync(join(here, `${label}.json`), JSON.stringify(out, null, 2));
console.log(`wrote ${label}.json`);
