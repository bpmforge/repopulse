import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIResponse, type Page } from '@playwright/test';

// The journey's hands and its notebook (W17-30).
//
// Everything the spec observes goes through `record`, so the evidence
// directory carries a machine-readable line for each fact beside the
// screenshot that shows it. The screenshots are numbered in the order they
// were taken, which is the order the journey happened.

export const EVIDENCE_DIR =
  process.env.JOURNEY_EVIDENCE_DIR ?? path.join('test-results', 'journey-evidence');
mkdirSync(EVIDENCE_DIR, { recursive: true });

let shots = 0;

/** A full-page screenshot into the evidence directory, numbered and named. */
export async function shot(page: Page, name: string): Promise<string> {
  shots += 1;
  const file = path.join(EVIDENCE_DIR, `${String(shots).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  record({ screenshot: path.basename(file), url: page.url() });
  return file;
}

/** One line of facts.jsonl. */
export function record(fact: Record<string, unknown>): void {
  appendFileSync(
    path.join(EVIDENCE_DIR, 'facts.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...fact })}\n`,
  );
}

/**
 * Drive the stack from outside the browser: stop a worker, attach the CVE
 * database. Delegated to deploy/journey.sh so compose knowledge lives in one
 * place; the spec only names the drill.
 */
export function ctl(...args: string[]): string {
  const script = process.env.JOURNEY_CTL;
  if (!script) {
    throw new Error('JOURNEY_CTL is not set — run the journey through deploy/journey.sh run');
  }
  const out = execFileSync('bash', [script, 'ctl', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  record({ ctl: args.join(' '), out: out.trim() });
  return out;
}

/**
 * The production API through the browser's own session. The header is the
 * CSRF guard the web app sends on every mutation (apps/api/src/plugins/
 * csrf-header.ts); without it the API answers 403, which is the point of it.
 */
export async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  data?: unknown,
): Promise<APIResponse> {
  const res = await page.request.fetch(url, {
    method,
    headers: { 'x-requested-with': 'repopulse' },
    ...(data !== undefined ? { data } : {}),
  });
  return res;
}

/** `api()` that fails loudly with the body when the status is not 2xx. */
export async function apiOk<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  data?: unknown,
): Promise<T> {
  const res = await api(page, method, url, data);
  const text = await res.text();
  expect(res.ok(), `${method} ${url} -> ${res.status()}: ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

/**
 * Reload and re-check until it holds. The screens fetch on load, and reloading
 * is what the person waiting for a backfill or a scan actually does.
 */
export async function untilOnReload(
  page: Page,
  check: () => Promise<void>,
  opts: { timeoutMs: number; everyMs?: number },
): Promise<void> {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout: opts.timeoutMs, intervals: [opts.everyMs ?? 5_000] });
}

/** Poll a JSON endpoint until the predicate holds; returns the last body. */
export async function untilApi<T>(
  page: Page,
  url: string,
  predicate: (body: T) => boolean,
  opts: { timeoutMs: number; everyMs?: number; label: string },
): Promise<T> {
  const every = opts.everyMs ?? 3_000;
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await apiOk<T>(page, 'GET', url);
    if (predicate(last)) return last;
    await page.waitForTimeout(every);
  }
  throw new Error(
    `${opts.label}: not reached within ${Math.round(opts.timeoutMs / 1000)}s; last body: ${JSON.stringify(last).slice(0, 2000)}`,
  );
}

export interface ScannerStatus {
  key: string;
  state: string;
  error: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  open_findings: number | null;
  scanner_version: string | null;
}

export interface SecurityPayload {
  scanners: ScannerStatus[];
  tooling?: { vuln_db?: { present: boolean } };
}

export const scannerOf = (p: SecurityPayload, key: string): ScannerStatus | undefined =>
  p.scanners.find((s) => s.key === key);

/** A run that has finished — anything but queued/in flight/never started. */
export const settled = (s: ScannerStatus | undefined): boolean =>
  s !== undefined && !['never_run', 'running', 'not_enabled'].includes(s.state);
