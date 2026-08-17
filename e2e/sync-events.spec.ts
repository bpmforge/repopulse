import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { FAKE_REPOS, FAKE_TOKEN } from './helpers/fake-forge.js';

// W4-22: the sync event stream, end to end.
//
// `publishSyncEvent` was built, documented and unit-tested with ZERO production
// callers, so GET /api/v1/events relayed a Redis channel nothing ever wrote to.
// The browser subscribed to four event names and received none of them. Nothing
// failed, because the design makes SSE an optimization over polled reads — the
// dashboard just looked slow.
//
// The existing assertion, `the sync stream connects — /api/v1/events is
// mounted`, was true the entire time and is exactly the kind of test that lets
// this happen: it proves the socket opens, not that anything comes down it.
//
// So this spec subscribes in the REAL browser, through the REAL endpoint, and
// waits for an event that only the worker can have published.

test('a worker-published event reaches the browser through the SSE endpoint', async ({ page }) => {
  test.setTimeout(90_000); // async: connect → plan → entity jobs → enrich → live

  await loginAsFixture(page);
  await page.goto('/');

  // Subscribe BEFORE causing any work — SSE has no replay, so a subscription
  // opened after the event is published would wait forever and the test would
  // fail for a reason that has nothing to do with the producer.
  const received = page.evaluate(
    () =>
      new Promise<{ type: string; data: Record<string, unknown> }[]>((resolve) => {
        const seen: { type: string; data: Record<string, unknown> }[] = [];
        const source = new EventSource('/api/v1/events');
        for (const name of ['sync.progress', 'sync.done', 'budget.warning', 'sync.repo']) {
          source.addEventListener(name, (event) => {
            // The frame's `data:` is the WHOLE {type, data} envelope, not just
            // the payload — formatSseFrame stringifies the event object, and
            // useSyncStream unwraps `.data.repoId` accordingly. Parsing it as
            // the payload directly is how a passing test would assert against
            // a shape the client never sees.
            seen.push(JSON.parse((event as MessageEvent).data) as never);
            // One progress event proves the path; resolve on the first rather
            // than waiting for a terminal event, so a change in HOW MANY events
            // ingestion emits does not turn this into a flaky test.
            if (seen.length > 0) {
              source.close();
              resolve(seen);
            }
          });
        }
        setTimeout(() => {
          source.close();
          resolve(seen);
        }, 75_000);
      }),
  );

  // Cause real ingestion — through the API rather than the UI, because a
  // `page.goto('/admin')` would tear down the EventSource opened above along
  // with the page that owns it. gamma-events belongs to this spec alone, so
  // anything that arrives was published by work THIS test started.
  const mine = FAKE_REPOS[2]!;
  const headers = { 'x-requested-with': 'repopulse' };

  // CREATE a connection rather than reusing one. The only connection present
  // at the start of a run is the SEEDER's, whose credential is synthetic — the
  // fake forge rejects it, so listRepos throws and repo selection 500s. A test
  // that reuses whatever is lying around inherits whatever state the previous
  // spec left, which is how an assertion starts depending on run order.
  const created = await page.request.post('/api/v1/connections', {
    headers,
    data: { provider: 'github', auth_kind: 'pat', credential: FAKE_TOKEN },
  });
  expect(created.ok(), `connection create failed: ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: number };

  const selected = await page.request.post(`/api/v1/connections/${id}/repos`, {
    headers,
    data: { repo_forge_ids: [String(mine.id)] },
  });
  expect(selected.ok(), `repo select failed: ${selected.status()} ${await selected.text()}`).toBe(
    true,
  );

  const events = await received;

  expect(
    events.length,
    'no sync event reached the browser — the worker publishes nothing, or the SSE relay dropped it',
  ).toBeGreaterThan(0);

  const first = events[0]!;
  expect(['sync.progress', 'sync.done', 'sync.repo']).toContain(first.type);
  // The payload the client actually reads (useSyncStream: repoId + phase + pct).
  // An event with no repoId is ignored by the store, so a stream of those would
  // pass a naive "did anything arrive" check and still leave the UI dead.
  expect(first.data.repoId, 'event carries no repoId — the client store ignores it').toBeDefined();
  expect(typeof first.data.pct).toBe('number');
});

test('a repo crossing 30-day coverage raises the first-insight toast (W4-21, R-A3)', async ({
  page,
}) => {
  test.setTimeout(90_000);

  await loginAsFixture(page);
  // The toast names the repo, and the name is read from the org health-tiles
  // response — so start on the screen that fetches it, as a user would.
  await page.goto('/');
  await expect(page.getByTestId('org-overview')).toBeVisible();

  // Cause real ingestion of a repo this spec owns, through the API so the page
  // (and its EventSource) survives.
  const headers = { 'x-requested-with': 'repopulse' };
  const created = await page.request.post('/api/v1/connections', {
    headers,
    data: { provider: 'github', auth_kind: 'pat', credential: FAKE_TOKEN },
  });
  expect(created.ok(), `connection create failed: ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: number };
  const mine = FAKE_REPOS[2]!;
  const selected = await page.request.post(`/api/v1/connections/${id}/repos`, {
    headers,
    data: { repo_forge_ids: [String(mine.id)] },
  });
  expect(selected.ok(), `repo select failed: ${selected.status()}`).toBe(true);

  // Backfill is RECENT-FIRST, so the 30-day window completes long before the
  // year does — which is the entire premise of R-A3. The toast is the only
  // thing that tells anyone.
  await expect(page.getByRole('status').filter({ hasText: /last 30 days ready/i })).toBeVisible({
    timeout: 60_000,
  });
});
