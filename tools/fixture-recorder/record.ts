import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeHeaders, scrubBody } from './sanitize.js';

// Fixture shape — kept structurally identical to packages/forge/fixtures/
// types.ts (Fixture). Duplicated as a local type rather than imported across
// the tree so this dev tool has no build coupling to the forge package.
interface Fixture {
  scenario: string;
  provenance: 'recorded' | 'synthetic';
  note?: string;
  request: { method: string; url: string; etagMatch?: string };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

export const GITHUB_API = 'https://api.github.com';
export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/forge/fixtures/github',
);

function token(): string {
  const t = process.env.GITHUB_PAT ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!t) throw new Error('set GITHUB_PAT (or GH_TOKEN) — a read token for recording');
  return t;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export interface RawResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Real GitHub REST call. `extraHeaders` carries e.g. If-None-Match for 304s. */
export async function githubFetch(
  method: string,
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<RawResult> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'repopulse-fixture-recorder',
      ...extraHeaders,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  if (res.headers.get('content-type')?.includes('application/json') && text.length > 0) {
    body = JSON.parse(text);
  }
  return { status: res.status, headers: headersToObject(res.headers), body };
}

export function writeFixture(fixture: Fixture): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const sanitized: Fixture = {
    ...fixture,
    response: {
      status: fixture.response.status,
      headers: sanitizeHeaders(fixture.response.headers),
      body: scrubBody(fixture.response.body),
    },
  };
  const path = join(FIXTURE_DIR, `${fixture.scenario}.json`);
  writeFileSync(path, JSON.stringify(sanitized, null, 2) + '\n');
  console.log(
    `wrote ${fixture.scenario}.json  (${fixture.provenance}, ${fixture.response.status})`,
  );
}

/** Record a live REST GET and persist it as a sanitized fixture. */
export async function recordRest(
  scenario: string,
  url: string,
  opts: { note?: string; etagMatch?: string; extraHeaders?: Record<string, string> } = {},
): Promise<RawResult> {
  const raw = await githubFetch('GET', url, opts.extraHeaders);
  writeFixture({
    scenario,
    provenance: 'recorded',
    ...(opts.note ? { note: opts.note } : {}),
    request: { method: 'GET', url, ...(opts.etagMatch ? { etagMatch: opts.etagMatch } : {}) },
    response: raw,
  });
  return raw;
}
