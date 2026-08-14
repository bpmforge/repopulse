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

  // A queue with no consumer is not automatically a defect — one of them is
  // supposed to have none. Conflating the two cases made "KNOWN_INERT == []"
  // an acceptance criterion on two tickets that NOTHING could ever satisfy.
  //
  // SINK: exhausted jobs are copied here by attachDeadLetter and held for the
  // admin ops page to inspect and replay (INGESTION §6). A processor would
  // consume them — i.e. delete the evidence — so "no consumer" is the
  // requirement here, not the debt.
  const SINK_QUEUES = ['dlq'] as const;

  // Queues whose processors are built but NOT registered. This list may only
  // ever SHRINK. It is now empty: W12-05 wired enrich and reconcile, and dlq
  // moved to SINK_QUEUES because it was never a processor's job.
  const KNOWN_INERT: readonly string[] = [];

  function registeredProcessors(): string[] {
    const worker = readIfPresent(join(API_SRC, 'workers/index.ts'));
    const block = /processors:\s*\{([\s\S]*?)\n\s{4}\}/.exec(worker)?.[1] ?? '';
    return Object.keys(QUEUE).filter((name) => block.includes(name));
  }

  it('every declared queue has a processor, or is an asserted sink', () => {
    const registered = registeredProcessors();
    const unconsumed = Object.keys(QUEUE).filter((q) => !registered.includes(q));
    const unexplained = unconsumed.filter(
      (q) => !KNOWN_INERT.includes(q) && !SINK_QUEUES.includes(q as (typeof SINK_QUEUES)[number]),
    );

    expect(
      unexplained,
      'this queue is declared, has no processor, and is neither tracked as inert nor declared a sink — work enqueued onto it is performed by nothing',
    ).toEqual([]);

    // The other direction: once a processor lands, its queue must leave the
    // list, so the debt cannot be quietly re-accrued behind a stale allowlist.
    expect(
      KNOWN_INERT.filter((q) => registered.includes(q)),
      'this queue now HAS a processor — remove it from KNOWN_INERT',
    ).toEqual([]);
  });

  it('the DLQ is a sink: fed by attachDeadLetter and consumed by nobody', () => {
    // Both halves matter. Losing attachDeadLetter means exhausted jobs vanish
    // silently; gaining a processor means they are consumed before anyone can
    // inspect or replay them. Either way the ops page shows an empty DLQ and
    // reads as "nothing has failed".
    const runtime = readIfPresent(join(API_SRC, 'workers/runtime.ts'));
    expect(
      runtime.includes('attachDeadLetter'),
      'nothing routes exhausted jobs to the DLQ — failures disappear instead of being recorded',
    ).toBe(true);

    const registered = registeredProcessors();
    expect(
      SINK_QUEUES.filter((q) => registered.includes(q)),
      'a sink queue has been given a processor — it would drain the failures the ops page exists to show',
    ).toEqual([]);
  });
});
