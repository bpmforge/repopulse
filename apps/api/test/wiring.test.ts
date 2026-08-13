import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEUE } from '@repopulse/ingest';

// PRODUCTION WIRING GATE.
//
// Four times in one week, code that was built, unit-tested and marked done was
// never registered in a production entrypoint: the SSE events route (W4-18),
// the connections/sync/webhook routes (W4-19), and every queue processor
// (W12-03). Each was found by accident while building something adjacent, and
// the suite stayed green throughout — because the unit tests mount the thing
// themselves into a throwaway scope, so the production wiring is exercised by
// nothing.
//
// This file exists so that class of defect fails loudly instead of being
// discovered months later by a customer whose dashboard never fills in.

const API_SRC = new URL('../src/', import.meta.url).pathname;

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('production wiring (regression gate)', () => {
  it('every route module is registered in a production entrypoint', () => {
    const routesDir = join(API_SRC, 'routes');
    const modules = readdirSync(routesDir).filter((d) =>
      existsSync(join(routesDir, d, 'index.ts')),
    );
    const wiring =
      readIfPresent(join(API_SRC, 'app.ts')) + readIfPresent(join(API_SRC, 'plugins/api-v1.ts'));

    const unmounted = modules.filter((m) => !wiring.includes(`routes/${m}/index.js`));
    expect(
      unmounted,
      'these route modules exist but are not registered — they serve 404 in production while their own tests pass',
    ).toEqual([]);
  });

  it('every declared queue has a processor, or is explicitly listed as known-inert', () => {
    // Queues whose processors are built but NOT yet registered, tracked by
    // W12-03. This list may only ever SHRINK: adding a queue without a
    // processor, or a new inert queue, fails here.
    //
    // Consequence of this debt today: connect enqueues work that nothing
    // performs, webhook deliveries are accepted and never applied, and metric
    // snapshots are never computed — the dashboard is populated by the seeder
    // alone, which is precisely why it looks healthy.
    const KNOWN_INERT = ['enrich', 'reconcile', 'dlq'] as const;

    const worker = readIfPresent(join(API_SRC, 'workers/index.ts'));
    const block = /processors:\s*\{([\s\S]*?)\}/.exec(worker)?.[1] ?? '';
    const registered = Object.keys(QUEUE).filter((name) => block.includes(name));
    const inert = Object.keys(QUEUE).filter((name) => !registered.includes(name));

    expect(
      inert.filter((q) => !KNOWN_INERT.includes(q as (typeof KNOWN_INERT)[number])),
      'a queue is declared with no processor and is not on the tracked W12-03 list',
    ).toEqual([]);

    // The other direction: once a processor lands, its queue must leave the
    // list, so the debt cannot be quietly re-accrued behind a stale allowlist.
    expect(
      KNOWN_INERT.filter((q) => registered.includes(q)),
      'this queue now HAS a processor — remove it from KNOWN_INERT',
    ).toEqual([]);
  });
});
