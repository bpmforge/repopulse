import { describe, expect, it } from 'vitest';
import {
  createReplayExecutor,
  loadGithubFixtures,
  matchFixture,
  ReplayMissError,
} from './replay.js';
import type { Fixture } from './types.js';

const fixtures = loadGithubFixtures();
const byScenario = (id: string): Fixture => {
  const fx = fixtures.find((f) => f.scenario === id);
  if (!fx) throw new Error(`missing fixture ${id} — run tools/fixture-recorder`);
  return fx;
};

describe('recorded fixture set (W0-04)', () => {
  it('covers every case named in PLAYBOOK §Per-ticket loop', () => {
    const ids = new Set(fixtures.map((f) => f.scenario));
    for (const required of [
      'repo-get-200-etag',
      'repo-get-304-conditional',
      'pull-files-200',
      'pull-files-truncated',
      'stats-contributors-202-warmup',
      'secondary-rate-limit-403',
    ]) {
      expect(ids, `fixture ${required}`).toContain(required);
    }
  });

  it('retains x-ratelimit-* and etag headers (budgeter/ETag inputs)', () => {
    const h = byScenario('repo-get-200-etag').response.headers;
    expect(h['etag']).toBeTruthy();
    expect(h['x-ratelimit-remaining']).toBeTruthy();
  });

  it('carries no token/authorization/cookie material (sanitizer guard)', () => {
    const blob = JSON.stringify(fixtures);
    expect(blob).not.toMatch(/gh[opusr]_[A-Za-z0-9]{20,}/);
    expect(blob).not.toMatch(/github_pat_/);
    expect(blob.toLowerCase()).not.toContain('authorization');
    expect(blob.toLowerCase()).not.toContain('set-cookie');
  });

  it('truncated-diff fixture has a file GitHub served with no patch', () => {
    const body = byScenario('pull-files-truncated').response.body as {
      patch?: string;
      changes: number;
    }[];
    const truncated = body.find((f) => f.patch === undefined && f.changes > 0);
    expect(truncated, 'a patch-less, non-empty file → patchTruncated').toBeTruthy();
  });
});

describe('replay executor (zero-network)', () => {
  it('serves the 200 for a plain GET and the 304 for the conditional GET on the same URL', async () => {
    const served: string[] = [];
    const exec = createReplayExecutor(fixtures, { onServe: (f) => served.push(f.scenario) });
    const url = byScenario('repo-get-200-etag').request.url;
    const etag = byScenario('repo-get-200-etag').response.headers['etag'] as string;

    const plain = await exec({ method: 'GET', url });
    expect(plain.status).toBe(200);

    const conditional = await exec({ method: 'GET', url, headers: { 'if-none-match': etag } });
    expect(conditional.status).toBe(304);

    expect(served).toEqual(['repo-get-200-etag', 'repo-get-304-conditional']);
  });

  it('serves the 202 warmup and the secondary-403', async () => {
    const exec = createReplayExecutor(fixtures);
    expect(
      (await exec({ method: 'GET', url: byScenario('stats-contributors-202-warmup').request.url }))
        .status,
    ).toBe(202);
    const four03 = await exec({
      method: 'GET',
      url: byScenario('secondary-rate-limit-403').request.url,
    });
    expect(four03.status).toBe(403);
    expect(four03.headers['retry-after']).toBe('60');
  });

  it('THROWS ReplayMissError on an unrecorded request — nothing escapes to github.com', async () => {
    const exec = createReplayExecutor(fixtures);
    await expect(
      exec({ method: 'GET', url: 'https://api.github.com/repos/acme/never-recorded' }),
    ).rejects.toBeInstanceOf(ReplayMissError);
  });

  it('a conditional request with the WRONG etag does not fall back to the 200 (no silent mismatch)', () => {
    const url = byScenario('repo-get-200-etag').request.url;
    const miss = matchFixture(fixtures, {
      method: 'GET',
      url,
      headers: { 'if-none-match': 'W/"not-the-recorded-etag"' },
    });
    expect(miss).toBeUndefined();
  });
});
