import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WINDOW_PRESETS } from '@repopulse/shared';
import { listQuery } from './index.js';

// W16-44. The repo PR list took no `window` at all while BOTH of its callers
// sent one. Fastify's zod provider drops an undeclared query param without
// complaint, so the repo screen's window control moved every widget on the page
// except the funnel and the size histogram — and the PR funnel then disagreed
// with the review-load matrix sitting directly beneath it, each reporting a
// different number of reviewed PRs for the same repo in the same window.
//
// Nothing failed. That is the whole difficulty with this class of bug: the
// request succeeds, the chart renders, and the number is simply from a
// different question than the one the reader asked.

describe('repo PR list window (W16-44)', () => {
  it('accepts every window the UI can select', () => {
    // Pinned to the SHARED presets rather than a copy: the control and the
    // route disagreeing by one preset is exactly how a param starts getting
    // dropped again, and a restated list here would agree with itself forever.
    for (const preset of WINDOW_PRESETS) {
      expect(listQuery.parse({ window: preset }).window, preset).toBe(preset);
    }
  });

  it('defaults to 30d, matching the other repo routes', () => {
    expect(listQuery.parse({}).window).toBe('30d');
  });

  it('actually filters the query by the window it parsed', () => {
    // A schema that DECLARES the param proves nothing — the bug being guarded
    // is a parsed value that no condition consumes. This asserts the handler
    // builds a createdAt lower bound from it, in the same spirit as the
    // worker-wiring source assertions elsewhere in the repo.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/WINDOW_DAYS\[request\.query\.window\]/);
    expect(source).toMatch(/gte\(facts\.pullRequests\.createdAt, windowStart\)/);
  });
});
