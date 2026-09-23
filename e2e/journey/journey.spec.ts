import { expect, test, type Page } from '@playwright/test';
import { FAKE_REPOS, FAKE_TOKEN } from '@repopulse/shared';
import {
  api,
  apiOk,
  ctl,
  record,
  scannerOf,
  settled,
  shot,
  untilApi,
  untilOnReload,
  type SecurityPayload,
} from './harness.js';

// THE COMPLETE CUSTOMER JOURNEY (W17-30), against an empty disposable install.
//
// Run through `./deploy/journey.sh run`, never directly: the script resets the
// demo stack so this starts from a first boot, stages the scan rules with the
// vulnerability database deliberately absent, and gives the drills a way to
// stop the worker. Every screen captured below shows something THIS run
// created — the product boots empty and nothing is seeded.
//
// What is production here: the sign-in and forced password change, the
// credential vault, the connect and repository-selection routes, the ingestion
// worker and its state machine, the Tier-2 client, the scan-runner. What is a
// fixture: the forge it talks to and the model it asks. Both are HTTP services
// the product reaches through its shipping client code; neither is a mock
// inside the process.

test.describe.configure({ mode: 'serial' });

const ADMIN_EMAIL = 'demo@repopulse.local';
const BOOTSTRAP_PASSWORD = 'demo-password-change-me';
const CHOSEN_PASSWORD = 'journey-chosen-password-2026';
const MODEL_BASE_URL = 'http://127.0.0.1:3399';

let page: Page;
let repoIds: number[] = [];
/** The repo the scan drills use: the first fixture repo, once ingested. */
let repoId = 0;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

// ---------------------------------------------------------------------------
// First boot
// ---------------------------------------------------------------------------

test('1. first sign-in forces the bootstrap admin to choose a password', async () => {
  await page.goto('/');
  await expect(page.getByTestId('signin-local')).toBeVisible();
  await shot(page, 'first-boot-sign-in');

  await page.getByTestId('signin-email').fill(ADMIN_EMAIL);
  await page.getByTestId('signin-password').fill(BOOTSTRAP_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // FORCED, not offered: an account created from ADMIN_PASSWORD keeps that
  // password only until its owner signs in.
  await expect(page.getByTestId('password-change')).toBeVisible();
  await shot(page, 'forced-password-change');

  await page.getByTestId('password-current').fill(BOOTSTRAP_PASSWORD);
  await page.getByTestId('password-new').fill(CHOSEN_PASSWORD);
  await page.getByTestId('password-confirm').fill(CHOSEN_PASSWORD);
  await page.getByTestId('password-submit').click();
  await expect(page.getByTestId('password-change')).toBeHidden();

  // The persona question is the second screen of a first login. Defer it —
  // the journey is the operator's, not a persona's.
  const picker = page.getByTestId('persona-picker');
  if (
    await picker.waitFor({ state: 'visible', timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await page.getByTestId('persona-defer').click();
    await expect(picker).toBeHidden();
  }
  record({ step: 1, signedInAs: ADMIN_EMAIL, passwordChanged: true });
});

test('2. the install is empty: no connections, no repositories, nothing to sync', async () => {
  await page.goto('/admin');
  // An empty Connections widget shows its empty message in place of the
  // table, so the table's testid is absent by design — the sentence is the
  // evidence, and the form above it is the way in.
  await expect(page.getByTestId('connection-credential')).toBeVisible();
  await expect(page.getByText('No connections yet')).toBeVisible();
  const connections = await page.getByTestId('connection-list').locator('tbody tr').count();
  expect(connections).toBe(0);

  const repos = await apiOk<{ items: unknown[] }>(page, 'GET', '/api/v1/repos');
  expect(repos.items).toHaveLength(0);
  await shot(page, 'empty-install-admin');

  await page.goto('/');
  await shot(page, 'empty-install-overview');
  record({ step: 2, connections, repos: repos.items.length });
});

// ---------------------------------------------------------------------------
// Connecting a forge — the rejected token first, then the real one
// ---------------------------------------------------------------------------

test('3. DRILL rejected forge token: the forge says no and the screen says so', async () => {
  await page.goto('/admin');
  await page.getByTestId('connection-credential').fill('ghp_this_token_is_wrong_on_purpose_000');
  await page.getByTestId('connection-submit').click();

  // The fixture forge checks Authorization and answers 401 exactly as GitHub
  // does; what is under test is that the product turns that into a sentence
  // about the credential rather than a generic failure or a stored dud.
  const error = page.getByTestId('connection-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/credential/i);
  await shot(page, 'drill-rejected-token');

  const connections = await page.getByTestId('connection-list').locator('tbody tr').count();
  expect(connections, 'a rejected token must not be stored').toBe(0);
  record({ step: 3, drill: 'rejected-forge-token', message: await error.textContent() });
});

test('4. connect with the fixture token and choose repositories', async () => {
  await page.goto('/admin');
  await page.getByTestId('connection-credential').fill(FAKE_TOKEN);
  await page.getByTestId('connection-submit').click();
  await expect(page.getByTestId('connection-result')).toBeVisible();
  await expect(page.getByTestId('connection-error')).toHaveCount(0);
  await expect(page.getByTestId('connection-credential')).toHaveValue('');

  // The picker lists what the token can see: the fixture forge's three repos.
  for (const repo of FAKE_REPOS) {
    const option = page.getByTestId(`repo-option-${repo.id}`).first();
    await expect(option).toBeVisible();
    await option.check();
  }
  await shot(page, 'connected-repos-chosen');
  await page.getByTestId('repo-select-submit').first().click();
  await expect(page.getByTestId('repo-select-result').first()).toBeVisible();

  // SC-2: the connection is described by fingerprint and last-4, never token.
  const listed = await (await api(page, 'GET', '/api/v1/connections')).text();
  expect(listed).not.toContain(FAKE_TOKEN);

  const repos = await apiOk<{ items: { id: number; org: string; name: string }[] }>(
    page,
    'GET',
    '/api/v1/repos',
  );
  expect(repos.items).toHaveLength(FAKE_REPOS.length);
  repoIds = repos.items.map((r) => r.id);
  const first = repos.items.find((r) => r.name === FAKE_REPOS[0]!.name);
  expect(first, 'the first fixture repo must now exist in the warehouse').toBeDefined();
  repoId = first!.id;
  record({ step: 4, tracked: repos.items.map((r) => `${r.org}/${r.name}#${r.id}`) });
});

// ---------------------------------------------------------------------------
// Ingestion, through the shipping worker
// ---------------------------------------------------------------------------

test('5. the backfill lands and every repository goes live', async () => {
  interface SyncStatus {
    phase: string;
    repos: { repoId: number; repoName?: string; phase: string; percentComplete: number }[];
  }
  const status = await untilApi<SyncStatus>(
    page,
    '/api/v1/sync/status',
    (s) => s.repos.length === FAKE_REPOS.length && s.repos.every((r) => r.phase === 'live'),
    { timeoutMs: 4 * 60_000, label: 'all repos live' },
  );

  await page.goto('/admin/sync');
  await expect(page.getByTestId('sync-repo-table')).toBeVisible();
  await expect(page.getByTestId('sync-repo-table').getByText('live', { exact: true })).toHaveCount(
    FAKE_REPOS.length,
  );
  await shot(page, 'sync-all-live');
  record({
    step: 5,
    phase: status.phase,
    repos: status.repos.map((r) => ({ id: r.repoId, phase: r.phase, pct: r.percentComplete })),
  });
});

test('6. the screens show what this run ingested', async () => {
  await page.goto('/');
  await expect(page.getByTestId('health-tile-grid')).toBeVisible();
  for (const id of repoIds) {
    await expect(page.getByTestId(`health-tile-${id}`)).toBeVisible();
  }
  await shot(page, 'org-overview-populated');

  await page.goto('/pull-requests');
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();
  const prRows = await rows.count();
  expect(prRows).toBeGreaterThan(0);
  await shot(page, 'pull-requests-populated');

  await page.goto(`/repos/${repoId}`);
  await expect(page.getByText(FAKE_REPOS[0]!.name).first()).toBeVisible();
  await shot(page, 'repo-detail');

  // System status: every component ready on a healthy install — the baseline
  // the dead-worker drill is measured against.
  await page.goto('/admin');
  await expect(page.getByTestId('system-state-worker')).toHaveText('Ready');
  await expect(page.getByTestId('system-state-forge')).toHaveText('Ready');
  await shot(page, 'system-status-all-ready');
  record({ step: 6, prRows, tiles: repoIds.length });
});

// ---------------------------------------------------------------------------
// Tier-2 through the real client, against the fixture model
// ---------------------------------------------------------------------------

async function addProvider(
  model: string,
  /**
   * What "Test connection" must say. The fixture-hang model hangs that request
   * too, so the API's own 20 s test deadline reports it — honestly, and inside
   * the run — as a connection it could not make. That sentence is part of the
   * model-timeout drill's evidence, not a reason to skip the test.
   */
  expectTest: RegExp = /Reached it/,
): Promise<number> {
  await page.goto('/admin/models');
  await page.getByTestId('provider-name').fill(`Journey ${model}`);
  await page.getByTestId('provider-base-url').fill(MODEL_BASE_URL);
  await page.getByTestId('provider-model').fill(model);

  // "Test connection" goes through the API to the model service, non-streamed,
  // and reports latency — the same path an operator uses before saving.
  await page.getByTestId('provider-test').click();
  const result = page.getByTestId('provider-test-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText(expectTest);
  // Read it now: saving resets the form and the result line goes with it.
  const testText = await result.textContent();

  await page.getByTestId('provider-save').click();
  const row = page.getByTestId('provider-table').locator(`[data-testid^="provider-row-"]`, {
    hasText: `Journey ${model}`,
  });
  await expect(row).toBeVisible();
  const id = Number((await row.getAttribute('data-testid'))!.replace('provider-row-', ''));
  record({ provider: { id, model, baseUrl: MODEL_BASE_URL, test: testText } });
  return id;
}

/**
 * The worker reuses a BUILT gateway for 60 s (apps/api/src/workers/gateway.ts,
 * createGatewayResolver ttlMs) — a deliberate bound on how stale a swapped
 * provider can be, chosen over a restart. A scan started inside that minute
 * runs on the previous model, so after a swap the drill waits the window out
 * rather than asserting against a cache. The api and worker are separate
 * processes; there is no signal to poll for. Recorded as a residual.
 */
async function awaitWorkerProviderRefresh(): Promise<void> {
  await page.waitForTimeout(61_000);
}

async function removeProvider(id: number): Promise<void> {
  await page.goto('/admin/models');
  await page.getByTestId(`provider-delete-${id}`).click();
  await expect(page.getByTestId(`provider-row-${id}`)).toHaveCount(0);
}

test('7. Admin → Models: the fixture model answers the real client', async () => {
  const id = await addProvider('fixture-model');
  await shot(page, 'models-fixture-model-saved');
  record({ step: 7, providerId: id });
});

test('8. the OWASP checklist produces a finding the evidence validator accepts', async () => {
  // No screen toggles a per-repo scanner yet; the API does (PUT /scanners/:key).
  // Recorded as a gap rather than worked around silently.
  await apiOk(page, 'PUT', '/api/v1/scanners/owasp_web', { repo_id: repoId, enabled: true });
  record({ step: 8, note: 'owasp_web enabled through the API: no UI toggle exists for it' });

  const started = await apiOk<{ started: string[] }>(page, 'POST', `/api/v1/repos/${repoId}/scan`, {
    scanner_key: 'owasp_web',
  });
  expect(started.started).toContain('owasp_web');

  const payload = await untilApi<SecurityPayload>(
    page,
    `/api/v1/repos/${repoId}/security`,
    (p) => settled(scannerOf(p, 'owasp_web')),
    { timeoutMs: 3 * 60_000, label: 'owasp_web settled' },
  );
  const row = scannerOf(payload, 'owasp_web')!;
  record({ step: 8, owasp_web: row });
  // A finding, from a model answer, through the validator: state `ok` with one
  // open finding. `all_rejected` here would mean the fixture's quote was not
  // verbatim; `error` would name what broke.
  expect(row.state, JSON.stringify(row)).toBe('ok');
  expect(row.open_findings).toBe(1);

  await page.goto(`/repos/${repoId}/security`);
  await expect(page.getByTestId('scanner-row-owasp_web')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('security-findings-list')).toContainText(
    'Fixture model: reviewed this added line',
  );
  await shot(page, 'security-owasp-finding-from-model');
});

// ---------------------------------------------------------------------------
// The deterministic scanners, a reload mid-queue, and the missing CVE database
// ---------------------------------------------------------------------------

test('9. DRILL reload during a queued job: the run survives the page', async () => {
  await page.goto(`/repos/${repoId}/security`);
  const runsBefore = (await apiOk<{ items: unknown[] }>(page, 'GET', '/api/v1/scanners/runs')).items
    .length;
  await page.getByTestId('run-scan-button').click();
  // Against the fixture forge the deterministic scanners settle in seconds, so
  // "Started …" may already have become "Running now: …" or "The scan has
  // settled" by the time the screen is read. Any of the three is the button
  // reporting the press; the runs endpoint is what proves it was queued.
  const status = page
    .locator(
      '[data-testid="run-scan-result"], [data-testid="run-scan-running"], [data-testid="run-scan-finished"]',
    )
    .first();
  await expect(status).toBeVisible();
  const startedText = await status.textContent();
  await untilApi<{ items: unknown[] }>(
    page,
    '/api/v1/scanners/runs',
    (r) => r.items.length > runsBefore,
    { timeoutMs: 60_000, label: 'the press queued at least one run' },
  );

  // Reload at once. The button's own memory of the start is gone; what the
  // screen shows now comes only from the warehouse's view of the queue.
  await page.reload();
  await expect(page.getByTestId('scanner-status')).toBeVisible();
  await shot(page, 'drill-reload-during-queued-scan');

  const payload = await untilApi<SecurityPayload>(
    page,
    `/api/v1/repos/${repoId}/security`,
    (p) => ['secrets', 'semgrep', 'dependency_cve'].every((k) => settled(scannerOf(p, k))),
    { timeoutMs: 6 * 60_000, label: 'manual scanners settled after reload' },
  );
  await page.reload();
  await expect(page.getByTestId('scanner-row-secrets')).toContainText('secrets.v1');
  await shot(page, 'scans-finished-after-reload');
  record({
    step: 9,
    drill: 'reload-during-queued-job',
    started: startedText,
    settled: payload.scanners
      .filter((s) => settled(s))
      .map((s) => ({ key: s.key, state: s.state, version: s.scanner_version })),
  });
});

test('10. DRILL unavailable scanner data: the CVE scan names the missing database and the fix', async () => {
  await page.goto(`/repos/${repoId}/security`);
  const dbStatus = page.getByTestId('vuln-db-status');
  await expect(dbStatus).toHaveAttribute('data-present', 'false');

  // The dependency scan ran in step 9 against a rules directory with no
  // database. It must say so and name the command — not read as clean.
  const row = page.getByTestId('scanner-row-dependency_cve');
  await expect(row).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('scanner-db-dependency_cve')).toContainText('scan-db-sync');
  await shot(page, 'drill-vuln-db-absent');
  const error = await page.getByTestId('scanner-error-dependency_cve').textContent();
  record({ step: 10, drill: 'unavailable-scanner-data', before: error });

  // RECOVERY: the operator runs the sync. Here the staged database is attached
  // in its place; the api and the runner see it through the same mount.
  ctl('vulndb', 'attach');
  await untilOnReload(
    page,
    async () => {
      await expect(page.getByTestId('vuln-db-status')).toHaveAttribute('data-present', 'true');
    },
    { timeoutMs: 60_000 },
  );

  const rerun = await apiOk<{ started: string[] }>(page, 'POST', `/api/v1/repos/${repoId}/scan`, {
    scanner_key: 'dependency_cve',
  });
  expect(rerun.started).toContain('dependency_cve');
  const before = scannerOf(
    await apiOk<SecurityPayload>(page, 'GET', `/api/v1/repos/${repoId}/security`),
    'dependency_cve',
  )!.last_run_at;
  const payload = await untilApi<SecurityPayload>(
    page,
    `/api/v1/repos/${repoId}/security`,
    (p) => {
      const s = scannerOf(p, 'dependency_cve');
      return settled(s) && s!.last_run_at !== before && s!.state !== 'running';
    },
    { timeoutMs: 6 * 60_000, label: 'dependency_cve rerun with the database present' },
  );
  const after = scannerOf(payload, 'dependency_cve')!;
  record({ step: 10, after });
  expect(['ok', 'partial', 'nothing_scanned'], JSON.stringify(after)).toContain(after.state);

  await page.reload();
  await expect(page.getByTestId('scanner-row-dependency_cve')).not.toHaveAttribute(
    'data-state',
    'error',
  );
  await shot(page, 'drill-vuln-db-recovered');
});

// ---------------------------------------------------------------------------
// The model that never answers
// ---------------------------------------------------------------------------

test('11. DRILL model timeout: a hanging model is reported within the run, then recovers', async () => {
  const listed = await apiOk<{ items: { id: number }[] }>(
    page,
    'GET',
    '/api/v1/admin/llm-providers',
  );
  for (const p of listed.items) await removeProvider(p.id);
  const hangId = await addProvider('fixture-hang', /Could not connect/);
  await awaitWorkerProviderRefresh();

  const started = await apiOk<{ started: string[] }>(page, 'POST', `/api/v1/repos/${repoId}/scan`, {
    scanner_key: 'owasp_web',
  });
  expect(started.started).toContain('owasp_web');
  const before = scannerOf(
    await apiOk<SecurityPayload>(page, 'GET', `/api/v1/repos/${repoId}/security`),
    'owasp_web',
  )!.last_run_at;

  // The overlay sets LMSTUDIO_REQUEST_TIMEOUT_MS=30000 for the worker, so the
  // client's own deadline — not a test timeout — is what ends this.
  const payload = await untilApi<SecurityPayload>(
    page,
    `/api/v1/repos/${repoId}/security`,
    (p) => {
      const s = scannerOf(p, 'owasp_web');
      return settled(s) && s!.last_run_at !== before && s!.state !== 'running';
    },
    { timeoutMs: 4 * 60_000, label: 'owasp_web against fixture-hang settled' },
  );
  const timedOut = scannerOf(payload, 'owasp_web')!;
  record({ step: 11, drill: 'model-timeout', run: timedOut });
  expect(timedOut.state, JSON.stringify(timedOut)).toBe('error');
  expect(timedOut.error ?? '').toMatch(/did not finish within 30s/);

  await page.goto(`/repos/${repoId}/security`);
  await expect(page.getByTestId('scanner-error-owasp_web')).toContainText('did not finish within');
  await shot(page, 'drill-model-timeout');

  // RECOVERY: point Tier-2 back at a model that answers, run again.
  await removeProvider(hangId);
  await addProvider('fixture-model');
  await awaitWorkerProviderRefresh();
  const again = await apiOk<{ started: string[] }>(page, 'POST', `/api/v1/repos/${repoId}/scan`, {
    scanner_key: 'owasp_web',
  });
  expect(again.started).toContain('owasp_web');
  const recovered = await untilApi<SecurityPayload>(
    page,
    `/api/v1/repos/${repoId}/security`,
    (p) => {
      const s = scannerOf(p, 'owasp_web');
      return settled(s) && s!.last_run_at !== timedOut.last_run_at && s!.state !== 'running';
    },
    { timeoutMs: 3 * 60_000, label: 'owasp_web recovered after the model was fixed' },
  );
  const row = scannerOf(recovered, 'owasp_web')!;
  record({ step: 11, recovered: row });
  // The drill is timeout-then-recover, not a green OWASP bill of health: the
  // proof is a SUCCEEDED run with no error after the model answered again.
  // Step 8 already created this repo's one fixture finding, so the re-run's
  // funnel is proposed 1 / created 0 / rejected 0 (deduplicated against the
  // open finding) and the row reads `all_rejected` rather than `ok` — an
  // honest residual recorded in the evidence, not a failed recovery.
  expect(row.last_run_status, JSON.stringify(row)).toBe('succeeded');
  expect(row.error, JSON.stringify(row)).toBeNull();
  expect(['ok', 'all_rejected'], JSON.stringify(row)).toContain(row.state);
  expect(row.open_findings).toBeGreaterThanOrEqual(1);
  // addProvider left the page on Admin → Models; go to the security screen.
  await page.goto(`/repos/${repoId}/security`);
  await expect(page.getByTestId('scanner-row-owasp_web')).toHaveAttribute('data-state', row.state);
  await expect(page.getByTestId('scanner-row-owasp_web')).not.toHaveAttribute(
    'data-state',
    'error',
  );
  await shot(page, 'drill-model-timeout-recovered');
});

// ---------------------------------------------------------------------------
// The worker that is not there
// ---------------------------------------------------------------------------

test('12. DRILL dead worker: named on the status screen, work waits, and drains on return', async () => {
  ctl('stop', 'worker');

  // The heartbeat has a 60s TTL; within about a minute the status screen must
  // stop saying Ready and say what it means for the install.
  await page.goto('/admin');
  await untilOnReload(
    page,
    async () => {
      await expect(page.getByTestId('system-state-worker')).not.toHaveText('Ready');
    },
    { timeoutMs: 120_000, everyMs: 10_000 },
  );
  const workerCard = page.getByTestId('system-component-worker');
  await expect(workerCard).toContainText(/heartbeat/i);
  await shot(page, 'drill-dead-worker-status');
  record({ step: 12, drill: 'dead-worker', status: await workerCard.textContent() });

  // A job started now has nobody to run it. The button must not sit on
  // "Queued…" for ever: after the pickup timeout it says so in a sentence.
  await page.goto(`/repos/${repoId}/security`);
  const runsBefore = (await apiOk<{ items: unknown[] }>(page, 'GET', '/api/v1/scanners/runs')).items
    .length;
  await page.getByTestId('run-scan-button').click();
  await expect(page.getByTestId('run-scan-result')).toContainText(/^Started/);
  await shot(page, 'drill-dead-worker-scan-started');
  await expect(page.getByTestId('run-scan-stalled')).toBeVisible({ timeout: 6 * 60_000 });
  const stalled = await page.getByTestId('run-scan-stalled').textContent();
  await shot(page, 'drill-dead-worker-stalled-sentence');
  record({ step: 12, stalled });

  // RECOVERY: bring the worker back. The queued job is still in Redis; nothing
  // is re-pressed.
  ctl('start', 'worker');
  await page.goto('/admin');
  await untilOnReload(
    page,
    async () => {
      await expect(page.getByTestId('system-state-worker')).toHaveText('Ready');
    },
    { timeoutMs: 120_000, everyMs: 5_000 },
  );
  await shot(page, 'drill-dead-worker-back');

  await untilApi<{ items: unknown[] }>(
    page,
    '/api/v1/scanners/runs',
    (r) => r.items.length > runsBefore,
    { timeoutMs: 3 * 60_000, label: 'the queued scan ran once the worker returned' },
  );
  await untilApi<SecurityPayload>(
    page,
    `/api/v1/repos/${repoId}/security`,
    (p) => p.scanners.every((s) => s.state !== 'running'),
    { timeoutMs: 6 * 60_000, label: 'the queued scans drained' },
  );
  await page.goto(`/repos/${repoId}/security`);
  await expect(page.getByTestId('run-scan-running')).toHaveCount(0);
  await shot(page, 'drill-dead-worker-drained');
  record({ step: 12, recovered: true, runsBefore });
});

test('13. the journey ends on a populated product', async () => {
  await page.goto('/');
  await expect(page.getByTestId('health-tile-grid')).toBeVisible();
  await shot(page, 'final-org-overview');
  record({ step: 13, done: true });
});
