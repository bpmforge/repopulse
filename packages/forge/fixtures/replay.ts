import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fixture, FixtureHttpResponse } from './types.js';

// Replay helper (W0-04): serves recorded GitHub fixtures to W1-06's
// ForgeProvider contract tests with ZERO live network. The returned function
// matches the BudgetedClient's `RequestExecutor` seam (packages/forge/src/
// client/budgeted-client.ts) — {method, url, headers} in, {status, headers,
// body} out — so W1-06 injects it exactly where a real fetch/octokit executor
// would go. A request that matches no fixture THROWS (ReplayMissError): the
// guard that proves nothing silently escapes to github.com in CI.

const GITHUB_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'github');

export class ReplayMissError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly hadIfNoneMatch: boolean,
  ) {
    super(
      `No recorded fixture for ${method} ${url}` +
        (hadIfNoneMatch ? ' (with If-None-Match)' : '') +
        ' — a live github.com call would have escaped. Record it via tools/fixture-recorder.',
    );
    this.name = 'ReplayMissError';
  }
}

/** Load every `*.json` fixture from packages/forge/fixtures/github. */
export function loadGithubFixtures(dir: string = GITHUB_FIXTURE_DIR): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture);
}

function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Pick the fixture for a request. The conditional discriminator: a request
 * carrying If-None-Match must land on a fixture whose `etagMatch` equals it
 * (the 304); a request without it must land on a fixture that has no
 * `etagMatch` (the 200). Undefined when nothing matches.
 */
export function matchFixture(
  fixtures: readonly Fixture[],
  req: { method: string; url: string; headers?: Record<string, string> },
): Fixture | undefined {
  const ifNoneMatch = req.headers ? headerLookup(req.headers, 'if-none-match') : undefined;
  return fixtures.find((fx) => {
    if (fx.request.method.toUpperCase() !== req.method.toUpperCase()) return false;
    if (fx.request.url !== req.url) return false;
    if (fx.request.etagMatch !== undefined) return fx.request.etagMatch === ifNoneMatch;
    return ifNoneMatch === undefined;
  });
}

export interface ReplayExecutorOptions {
  /** Called on every served request — lets a test assert exact call sequences. */
  onServe?: (fixture: Fixture) => void;
}

export type ReplayRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
};

/**
 * Build a zero-network executor over `fixtures`. Shape-compatible with
 * BudgetedClient's RequestExecutor (headers optional here so plain matcher
 * tests can call it without them). Throws ReplayMissError on any miss.
 */
export function createReplayExecutor(
  fixtures: readonly Fixture[],
  opts: ReplayExecutorOptions = {},
): (req: ReplayRequest) => Promise<FixtureHttpResponse> {
  return async (req) => {
    const fixture = matchFixture(fixtures, req);
    if (!fixture) {
      const had = req.headers ? headerLookup(req.headers, 'if-none-match') !== undefined : false;
      throw new ReplayMissError(req.method, req.url, had);
    }
    opts.onServe?.(fixture);
    return fixture.response;
  };
}
