import { describe, expect, it, vi } from 'vitest';
import { scanProcessor, type ScanJobData } from './scan-processor.js';

// W16-20 / W16-28. What happens when a scan is asked for and cannot happen.
//
// The user walk pressed "Run scans now", was told four scanners had started,
// and the coverage table went on saying "has never run" for all four. Two
// separate silent-nothings produced that:
//
//   a scanner with NO history runner wired returned quietly
//   a scanner WITH one returned quietly when it swept zero commits
//
// Both are the failure this product's copy is otherwise careful about — an
// absence that reads as a measurement. Neither is an exception: an unwired
// scanner and an unconnected repository are deployment facts, so each records a
// run that says so.
//
// The db is stubbed on purpose: this is about control flow, and a live-Postgres
// fixture here would need the whole workspace → connection → repo chain that
// W16-17 is about.

function stubDb() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { returning: async () => [{ id: 1 }] };
      },
    }),
  };
  return { db: db as never, inserted };
}

const job = (over: Partial<ScanJobData> = {}): ScanJobData => ({
  workspaceId: 1,
  repoId: 2,
  scannerKey: 'dependency',
  commitSha: '',
  trigger: 'manual',
  mode: 'history',
  ...over,
});

describe('a history scan that cannot run says so (W16-20)', () => {
  it('records a failed run naming the scanner with no runner', async () => {
    const { db, inserted } = stubDb();
    // No historyRunners at all — the shipped worker wires only `secrets`.
    await scanProcessor({ db })({ data: job() } as never);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ scannerKey: 'dependency', status: 'failed' });
    expect(String(inserted[0]?.error)).toMatch(/no history runner is wired/i);
    // Named, so the row says which scanner and which server rather than "error".
    expect(String(inserted[0]?.error)).toContain('dependency');
  });

  it('does not silently succeed, which would leave the table reading "never"', async () => {
    const { db, inserted } = stubDb();
    await scanProcessor({ db })({ data: job({ scannerKey: 'semgrep' }) } as never);
    expect(inserted[0]?.status).not.toBe('succeeded');
  });
});

describe('a history runner that scanned nothing says so (W16-28)', () => {
  it('distinguishes "no forge connection" from "nothing to sweep"', async () => {
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => ({
      scanned: 0,
      findingsCreated: 0,
      deferred: 0,
      skipped: 'no_connection' as const,
    }));

    await scanProcessor({ db, historyRunners: { secrets: runner } })({
      data: job({ scannerKey: 'secrets' }),
    } as never);

    expect(runner).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(1);
    // Succeeded, because an unconnected repository is not a fault — but it must
    // leave a row, or the screen keeps saying the scan never happened.
    expect(inserted[0]).toMatchObject({
      scannerKey: 'secrets',
      status: 'succeeded',
      findingCount: 0,
    });
    expect(String(inserted[0]?.error)).toMatch(/no forge connection/i);
  });

  it('says nothing-in-range when the repo is connected but empty', async () => {
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => ({ scanned: 0, findingsCreated: 0, deferred: 0 }));

    await scanProcessor({ db, historyRunners: { secrets: runner } })({
      data: job({ scannerKey: 'secrets' }),
    } as never);

    expect(String(inserted[0]?.error)).toMatch(/no commits in range/i);
    // The distinction the product's copy exists to preserve.
    expect(String(inserted[0]?.error)).toMatch(/not the same as nothing being found/i);
  });

  it('records a failed run when the runner THROWS, and still rethrows', async () => {
    // Without this a raising runner leaves no scan_run at all: the job lands in
    // job_failure, which only an admin looking at the dead-letter queue ever
    // sees, while the coverage table goes on saying "has never run" to the
    // person who just pressed the button.
    //
    // Found with a real one — the demo's seeded forge credential could not be
    // decrypted, so every secrets scan died with "ciphertext too short" and the
    // screen showed nothing whatsoever.
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => {
      throw new Error('ciphertext too short');
    });

    await expect(
      scanProcessor({ db, historyRunners: { secrets: runner } })({
        data: job({ scannerKey: 'secrets' }),
      } as never),
    ).rejects.toThrow(/ciphertext too short/);

    // Recorded for the screen...
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ scannerKey: 'secrets', status: 'failed' });
    expect(inserted[0]?.error).toBe('ciphertext too short');
    // ...and rethrown, because the retry and dead-letter behaviour is
    // deliberate (NFR-11); swallowing it would trade one silence for another.
  });

  it('reaches a WEEKLY runner when a manual run has no history one (W16-28)', async () => {
    // "Run scans now" enqueues mode:'history' for every enabled scanner, and
    // only `secrets` has a history runner — so the button reached real work for
    // one scanner and recorded "no history runner is wired" for the rest.
    const { db, inserted } = stubDb();
    const weekly = vi.fn(async () => ({ scanned: 4, findingsCreated: 1, deferred: 0 }));

    await scanProcessor({ db, weeklyRunners: { code_health_tools: weekly } })({
      data: job({ scannerKey: 'code_health_tools' }),
    } as never);

    expect(weekly).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });

  it('prefers the history runner when a scanner has both', async () => {
    const { db, inserted } = stubDb();
    const history = vi.fn(async () => ({ scanned: 1, findingsCreated: 0, deferred: 0 }));
    const weekly = vi.fn(async () => ({ scanned: 1, findingsCreated: 0, deferred: 0 }));

    await scanProcessor({
      db,
      historyRunners: { secrets: history },
      weeklyRunners: { secrets: weekly },
    })({ data: job({ scannerKey: 'secrets' }) } as never);

    expect(history).toHaveBeenCalledOnce();
    expect(weekly).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('records the same zero-work row on the WEEKLY path (W16-28)', async () => {
    // The weekly and history branches ran byte-identical bodies, which is how
    // the throw case came to be handled in one and not the other. One helper
    // now, and this asserts the second caller reaches it.
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => {
      throw new Error('ciphertext too short');
    });

    await expect(
      scanProcessor({ db, weeklyRunners: { semgrep: runner } })({
        data: job({ scannerKey: 'semgrep', mode: 'weekly' }),
      } as never),
    ).rejects.toThrow(/ciphertext too short/);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ scannerKey: 'semgrep', status: 'failed' });
  });

  it('a runner that FAILED BY RETURNING is a failed row, not a clean sweep (W16-35)', async () => {
    // The regression W16-28 introduced and the W16-29 screenshot caught: most
    // runners wrap a result instead of throwing, so a failed semgrep or
    // code-health run came back as scanned:0 with its real error in `skipped`
    // — and this processor recorded it as SUCCEEDED, saying "No commits in
    // range to sweep" and discarding the error. Anti-slop threw and read
    // "last run failed — archive request returned 401"; code health returned
    // and read "ran clean", from the same 401.
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => ({
      scanned: 0,
      findingsCreated: 0,
      deferred: 0,
      error: 'archive request returned 404',
    }));

    await scanProcessor({ db, historyRunners: { semgrep: runner } })({
      data: job({ scannerKey: 'semgrep' }),
    } as never);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ status: 'failed' });
    expect(inserted[0]?.error).toBe('archive request returned 404');
    // NOT the nothing-to-sweep sentence, which is what it used to say.
    expect(String(inserted[0]?.error)).not.toMatch(/no commits in range/i);
  });

  it('names the reason it was given, rather than asserting one (W16-35)', async () => {
    // The old ternary had two cases for at least six reasons: everything that
    // was not `no_connection` claimed "no commits in range", including
    // `no_sbom` and `no_head_sha`, which are not claims about commits.
    const cases: [string, RegExp][] = [
      ['no_head_sha', /no ingested commit/i],
      ['no_sbom', /no SBOM/i],
      ['no_llm_packages', /does not apply/i],
      // A reason this processor has not been taught is QUOTED, not replaced by
      // a plausible sentence about something else.
      ['some_future_reason', /some_future_reason/],
    ];
    for (const [reason, expected] of cases) {
      const { db, inserted } = stubDb();
      const runner = vi.fn(async () => ({
        scanned: 0,
        findingsCreated: 0,
        deferred: 0,
        skipped: reason,
      }));
      await scanProcessor({ db, historyRunners: { secrets: runner } })({
        data: job({ scannerKey: 'secrets' }),
      } as never);
      expect(inserted[0], reason).toMatchObject({ status: 'succeeded' });
      expect(String(inserted[0]?.error), reason).toMatch(expected);
    }
  });

  it('writes NOTHING extra when the sweep actually covered commits', async () => {
    // The sweeper writes its own row per commit; a second summary row here
    // would double-count a real scan.
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => ({ scanned: 12, findingsCreated: 3, deferred: 0 }));

    await scanProcessor({ db, historyRunners: { secrets: runner } })({
      data: job({ scannerKey: 'secrets' }),
    } as never);

    expect(runner).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });
});

// 2026-10-27 walkthrough: findings a scan wrote stayed unpriced until the
// nightly snapshot, so "Risk (highest first)" ordered 65 of ~22,600.
describe('a scan queues a reprice of its repository', () => {
  it('calls afterScan once the job has scanned, and not for a sweep fan-out', async () => {
    const { db } = stubDb();
    const afterScan = vi.fn(async () => {});
    const runner = vi.fn(async () => ({ scanned: 1, findingsCreated: 0, deferred: 0 }));
    const process = scanProcessor({
      db,
      historyRunners: { secrets: runner },
      afterScan,
      historySweep: async () => ({ enqueued: 0 }),
    });

    await process({ data: job({ scannerKey: 'secrets' }) } as never);
    expect(afterScan).toHaveBeenCalledTimes(1);
    expect(afterScan).toHaveBeenCalledWith(expect.objectContaining({ repoId: 2 }));

    await process({ data: job({ mode: 'history_sweep', scannerKey: 'secrets' }) } as never);
    expect(afterScan).toHaveBeenCalledTimes(1);
  });
});
