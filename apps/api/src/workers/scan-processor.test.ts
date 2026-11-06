import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { core, facts, security } from '@repopulse/shared';
import {
  antiSlopDataVersion,
  codeHealthDataVersion,
  dependencyDataVersion,
  imageDataVersion,
  registerBuiltinScanners,
  registerScanner,
  ruleStateStamp,
  semgrepDataVersion,
  snapshotForScan,
  type ScanProbe,
  type Scanner,
} from '@repopulse/security';
import type { ForgeProvider } from '@repopulse/forge';
import {
  architectureDataVersion,
  buildScanProbes,
  supplyChainDataVersion,
} from '../routes/runs/probes.js';
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

function stubDb(prior: Record<string, unknown>[] = []) {
  const inserted: Record<string, unknown>[] = [];
  // W23-01: the up-to-date lookup is a select chain. The stub hands back the
  // seeded rows WITHOUT applying the WHERE clause — isUpToDate re-applies its
  // own predicates in memory, which is what these tests lean on.
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => prior,
  };
  const db = {
    select: () => chain,
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
    const runner = vi.fn(async () => ({
      scanned: 0,
      findingsCreated: 0,
      deferred: 0,
      skipped: 'no_targets',
    }));

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

  it('a runner that gave NO reason is not told it had no commits (W25-03)', async () => {
    // 0.2.0 install: the architecture and knowledge registers and the attack
    // chainer returned scanned 0 with no reason, and the coverage table said
    // "No commits in range to sweep" for scanners that never sweep commits.
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => ({ scanned: 0, findingsCreated: 0, deferred: 0 }));
    await scanProcessor({ db, historyRunners: { knowledge_register: runner } })({
      data: job({ scannerKey: 'knowledge_register' }),
    } as never);
    expect(inserted[0]).toMatchObject({ status: 'succeeded' });
    expect(String(inserted[0]?.error)).not.toMatch(/commits/i);
    expect(String(inserted[0]?.error)).toMatch(/did not say why/i);
  });

  it('names the new W25-03 reasons', async () => {
    const cases: [string, RegExp][] = [
      ['no_supported_language', /no architecture tool/i],
      ['no_history_in_window', /no ingested commit in the register's window/i],
    ];
    for (const [reason, expected] of cases) {
      const { db, inserted } = stubDb();
      const runner = vi.fn(async () => ({
        scanned: 0,
        findingsCreated: 0,
        deferred: 0,
        skipped: reason,
      }));
      await scanProcessor({ db, historyRunners: { architecture_register: runner } })({
        data: job({ scannerKey: 'architecture_register' }),
      } as never);
      expect(String(inserted[0]?.error), reason).toMatch(expected);
    }
  });

  it('writes no second row when the runner recorded its own (W25-03)', async () => {
    // "No attack chains" is a measurement the chainer already wrote down; a
    // "nothing was scanned" row after it buried that answer.
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => ({
      scanned: 0,
      findingsCreated: 0,
      deferred: 0,
      recordedRun: true,
    }));
    await scanProcessor({ db, historyRunners: { attack_chainer: runner } })({
      data: job({ scannerKey: 'attack_chainer' }),
    } as never);
    expect(runner).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
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

// W23-01. An unchanged scan is answered from the earlier run instead of being
// re-run: the weekly cron over a repo nobody pushed to, and a second press of
// Run scans now, each used to fetch a tarball and run every tool for the same
// result. The things worth proving are the refusals — force, a changed tool
// version, and another workspace's run must all still reach the runner.
describe('an unchanged scan is not re-run (W23-01)', () => {
  const SHA = 'abc123';
  const VERSIONS = { opengrep: '1.0.0', rulepack: 'a.yaml' };
  const priorRun = (over: Record<string, unknown> = {}) => ({
    id: 41,
    workspaceId: 1,
    repoId: 2,
    scannerKey: 'semgrep',
    commitSha: SHA,
    status: 'succeeded',
    partial: false,
    scope: 'full',
    trigger: 'schedule',
    findingCount: 9,
    toolVersions: VERSIONS,
    dataVersion: null,
    scannerVersion: 'opengrep@1.0.0 rulepack@a.yaml',
    finishedAt: new Date('2026-10-29T00:00:00Z'),
    ...over,
  });
  const probes = (
    result: Awaited<ReturnType<ScanProbe>> = { commitSha: SHA, toolVersions: { ...VERSIONS } },
  ): Record<string, ScanProbe> => ({ semgrep: vi.fn(async () => result) });
  const runner = () => vi.fn(async () => ({ scanned: 1, findingsCreated: 0, deferred: 0 }));
  const weeklyJob = (over: Partial<ScanJobData> = {}) =>
    job({ scannerKey: 'semgrep', mode: 'weekly', trigger: 'schedule', ...over });

  it('a second weekly job at the same sha and tool versions does not call the runner', async () => {
    const { db, inserted } = stubDb([priorRun()]);
    const semgrep = runner();

    await scanProcessor({ db, weeklyRunners: { semgrep }, probes: probes() })({
      data: weeklyJob(),
    } as never);

    expect(semgrep).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      workspaceId: 1,
      repoId: 2,
      scannerKey: 'semgrep',
      status: 'succeeded',
      scope: 'skipped',
      // The earlier result, restated, and where it came from.
      findingCount: 9,
      baseRunId: 41,
      // The REAL commit, not the job's (a manual job carries '').
      commitSha: SHA,
      trigger: 'schedule',
    });
    expect(String(inserted[0]?.error)).toMatch(/nothing changed since the last successful run/i);
    expect(String(inserted[0]?.error)).toContain('Full rescan');
  });

  it('a MANUAL (history) job takes the same short-circuit and records the real commit', async () => {
    const { db, inserted } = stubDb([priorRun({ trigger: 'manual' })]);
    const semgrep = runner();

    await scanProcessor({ db, weeklyRunners: { semgrep }, probes: probes() })({
      data: job({ scannerKey: 'semgrep', mode: 'history', commitSha: '' }),
    } as never);

    expect(semgrep).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ scope: 'skipped', commitSha: SHA, trigger: 'manual' });
  });

  it('force:true calls the runner and writes no skipped row', async () => {
    const { db, inserted } = stubDb([priorRun()]);
    const semgrep = runner();
    const p = probes();

    await scanProcessor({ db, weeklyRunners: { semgrep }, probes: p })({
      data: weeklyJob({ force: true }),
    } as never);

    expect(semgrep).toHaveBeenCalledOnce();
    // Not even asked: a forced job must not pay for the probe.
    expect(p['semgrep']).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('changed tool_versions call the runner', async () => {
    const { db, inserted } = stubDb([priorRun()]);
    const semgrep = runner();

    await scanProcessor({
      db,
      weeklyRunners: { semgrep },
      probes: probes({ commitSha: SHA, toolVersions: { ...VERSIONS, opengrep: '2.0.0' } }),
    })({ data: weeklyJob() } as never);

    expect(semgrep).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });

  it('a new head commit calls the runner', async () => {
    // The seeded run is for SHA; the probe says the head has moved. (A real db
    // would return no rows for the new sha; the stub returns the old row and
    // isUpToDate rejects it in memory.)
    const { db } = stubDb([priorRun()]);
    const semgrep = runner();

    await scanProcessor({
      db,
      weeklyRunners: { semgrep },
      probes: probes({ commitSha: 'newer-sha', toolVersions: { ...VERSIONS } }),
    })({ data: weeklyJob() } as never);

    expect(semgrep).toHaveBeenCalledOnce();
  });

  it('a succeeded run in ANOTHER WORKSPACE never counts', async () => {
    // Same repo id, same sha, same versions — a different tenant's row.
    const { db, inserted } = stubDb([priorRun({ workspaceId: 99 })]);
    const semgrep = runner();

    await scanProcessor({ db, weeklyRunners: { semgrep }, probes: probes() })({
      data: weeklyJob(),
    } as never);

    expect(semgrep).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });

  it('a failed, partial or skipped earlier run does not count', async () => {
    for (const over of [{ status: 'failed' }, { partial: true }, { scope: 'skipped' }]) {
      const { db } = stubDb([priorRun(over)]);
      const semgrep = runner();
      await scanProcessor({ db, weeklyRunners: { semgrep }, probes: probes() })({
        data: weeklyJob(),
      } as never);
      expect(semgrep, JSON.stringify(over)).toHaveBeenCalledOnce();
    }
  });

  it('a scanner with no probe always runs, and a probe that cannot say runs it too', async () => {
    const { db, inserted } = stubDb([priorRun()]);
    const semgrep = runner();

    // No `probes` at all.
    await scanProcessor({ db, weeklyRunners: { semgrep } })({ data: weeklyJob() } as never);
    expect(semgrep).toHaveBeenCalledTimes(1);

    // A probe that returns null (no head commit, version unreadable)...
    await scanProcessor({ db, weeklyRunners: { semgrep }, probes: probes(null) })({
      data: weeklyJob(),
    } as never);
    expect(semgrep).toHaveBeenCalledTimes(2);

    // ...and one that throws: a skip is earned by evidence, never by a failure to look.
    await scanProcessor({
      db,
      weeklyRunners: { semgrep },
      probes: {
        semgrep: async () => {
          throw new Error('podman not found');
        },
      },
    })({ data: weeklyJob() } as never);
    expect(semgrep).toHaveBeenCalledTimes(3);
    expect(inserted).toHaveLength(0);
  });

  it('reads the data stamp from registry metadata, not from the scanner key', async () => {
    const stamp = vi.fn(async () => 'db-2026-10-31');
    const scanner: Scanner = {
      key: 'w23_01_data_scanner',
      displayName: 'W23-01 test scanner',
      version: 'w23.v1',
      inputs: 'snapshot',
      triggers: ['manual'],
      dataVersion: stamp,
      run: async () => [],
    };
    registerScanner(scanner);
    const runnerFn = runner();
    const withProbe: Record<string, ScanProbe> = {
      w23_01_data_scanner: async () => ({ commitSha: SHA, toolVersions: null }),
    };
    const base = priorRun({ scannerKey: 'w23_01_data_scanner', toolVersions: null });

    // The earlier run recorded a different stamp: the data moved, so re-scan.
    const stale = stubDb([{ ...base, dataVersion: 'db-2026-10-29' }]);
    await scanProcessor({
      db: stale.db,
      weeklyRunners: { w23_01_data_scanner: runnerFn },
      probes: withProbe,
    })({ data: weeklyJob({ scannerKey: 'w23_01_data_scanner' }) } as never);
    expect(stamp).toHaveBeenCalled();
    expect(runnerFn).toHaveBeenCalledOnce();

    // Same stamp: up to date, and the skipped row carries it.
    const fresh = stubDb([{ ...base, dataVersion: 'db-2026-10-31' }]);
    await scanProcessor({
      db: fresh.db,
      weeklyRunners: { w23_01_data_scanner: runnerFn },
      probes: withProbe,
    })({ data: weeklyJob({ scannerKey: 'w23_01_data_scanner' }) } as never);
    expect(runnerFn).toHaveBeenCalledOnce();
    expect(fresh.inserted[0]).toMatchObject({ scope: 'skipped', dataVersion: 'db-2026-10-31' });
  });

  it('real runs are not marked: the processor writes no scope of its own for them', async () => {
    // The default is 'full' in the column; a runner that does work leaves its
    // own rows, and the processor adds none (the existing contract).
    const { db, inserted } = stubDb([]);
    const semgrep = runner();
    await scanProcessor({ db, weeklyRunners: { semgrep }, probes: probes() })({
      data: weeklyJob(),
    } as never);
    expect(semgrep).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });
});

describe('force reaches the runner (W23-09)', () => {
  it('passes force only on a forced job, so secrets history can bypass its covered filter', async () => {
    const seen: unknown[] = [];
    const secrets = vi.fn(async (args: unknown) => {
      seen.push(args);
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    });
    const { db } = stubDb();
    const process = scanProcessor({ db, historyRunners: { secrets } });

    await process({ data: job({ scannerKey: 'secrets' }) } as never);
    await process({ data: job({ scannerKey: 'secrets', force: true }) } as never);

    expect(seen).toEqual([
      { workspaceId: 1, repoId: 2 },
      { workspaceId: 1, repoId: 2, force: true },
    ]);
  });
});

// W23-09 acceptance 5. The point of the whole ticket: press "Run scans now" twice
// with nothing pushed and the second press must not touch the forge. A stateful
// in-memory db, the REAL probes and the REAL processor; each stand-in runner does
// what the real one does at its edges: fetch the pinned tarball through
// snapshotForScan (the only sanctioned path, which counts on the fake provider),
// then leave a succeeded row stamped by the same data-version function the real
// runner calls.
describe('two presses with no new commit fetch no tarball (W23-09)', () => {
  type Row = Record<string, unknown>;
  const HEAD1 = 'a'.repeat(40);
  const HEAD2 = 'b'.repeat(40);
  const SBOM_SHA = 'c'.repeat(40);

  let scanRules: string;
  let savedRules: string | undefined;

  beforeAll(() => {
    registerBuiltinScanners();
    savedRules = process.env['SCAN_RULES_DIR'];
    scanRules = mkdtempSync(path.join(tmpdir(), 'w23-09-press-'));
    process.env['SCAN_RULES_DIR'] = scanRules;
    // A grype database the way scan-db-sync.sh leaves it, built yesterday.
    const schema = path.join(scanRules, 'vuln-db', '6');
    mkdirSync(schema, { recursive: true });
    writeFileSync(path.join(schema, 'vulnerability.db'), 'db');
    const stamp = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    writeFileSync(
      path.join(schema, 'import.json'),
      JSON.stringify({ source: `https://grype.example/vulnerability-db_v6_${stamp}.tar.zst` }),
    );
  });
  afterAll(() => {
    if (savedRules === undefined) delete process.env['SCAN_RULES_DIR'];
    else process.env['SCAN_RULES_DIR'] = savedRules;
    rmSync(scanRules, { recursive: true, force: true });
  });

  /** A real gzipped tar, built by the system tar (same discipline as W8-03). */
  function tarball(): Uint8Array {
    const stage = mkdtempSync(path.join(tmpdir(), 'w23-09-tar-'));
    const top = path.join(stage, 'acme-app-abc1234');
    mkdirSync(top, { recursive: true });
    writeFileSync(path.join(top, 'index.js'), 'module.exports = {};\n');
    const out = path.join(stage, 'archive.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const bytes = new Uint8Array(readFileSync(out));
    rmSync(stage, { recursive: true, force: true });
    return bytes;
  }

  function world() {
    const tables = new Map<unknown, Row[]>();
    const rows = (t: unknown): Row[] => {
      if (!tables.has(t)) tables.set(t, []);
      return tables.get(t)!;
    };
    const chain = (list: Row[]) => {
      const c = {
        where: () => c,
        orderBy: () => c,
        limit: async () => list,
        then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(list).then(res, rej),
      };
      return c;
    };
    let nextId = 1;
    const db = {
      select: () => ({ from: (t: unknown) => chain(rows(t)) }),
      insert: (t: unknown) => ({
        values: (row: Row) => {
          const full = {
            id: nextId++,
            status: 'running',
            partial: false,
            scope: 'full',
            findingCount: 0,
            toolVersions: null,
            dataVersion: null,
            scannerVersion: 'x',
            finishedAt: null,
            ...row,
          };
          rows(t).unshift(full); // newest first, like the real ORDER BY id DESC
          return { returning: async () => [full] };
        },
      }),
    } as never;

    const tarballBytes = tarball();
    // A RECORDING provider: every port method the scan path touches is logged by
    // name, so the test counts what actually went to the forge rather than what
    // a hand-written stub chose to report. (C1a: the archive is the only thing a
    // snapshot scanner may ask for, and the architecture rule that keeps that true
    // bans naming the method outside packages/forge and packages/security, which
    // is also why this matches on the name instead of spelling it.)
    const portCalls: string[] = [];
    const fetches: string[] = [];
    const provider = new Proxy(
      { kind: 'github', capabilities: { supportsTarball: true } } as Record<string, unknown>,
      {
        get(target, prop) {
          if (typeof prop !== 'string' || prop in target) return target[prop as string];
          return async (_ctx: unknown, _repo: string, sha: string) => {
            portCalls.push(prop);
            if (/Tarball$/.test(prop)) fetches.push(sha);
            return { commitSha: sha, bytes: tarballBytes, sourceHost: 'codeload.github.com' };
          };
        },
      },
    ) as unknown as ForgeProvider;

    rows(facts.commits).push({ sha: HEAD1 });
    rows(core.workspaces).push({ settings: null });
    rows(security.sboms).push({ id: 5, commitSha: SBOM_SHA });
    return { db, rows, provider, fetches, portCalls };
  }

  it('creates zero tarball fetches on the second press, and fetches again for a new commit or a forced one', async () => {
    const { db, rows, provider, fetches, portCalls } = world();
    const head = () => rows(facts.commits)[0]!['sha'] as string;
    const ran: string[] = [];

    /** What a snapshot runner does: stamp (before), fetch, leave a succeeded row. */
    const snapshotRunner =
      (
        key: string,
        stamp: () => Promise<{
          toolVersions: Record<string, string> | null;
          dataVersion: string | null;
          commitSha?: string;
        }>,
      ) =>
      async () => {
        const s = await stamp();
        const sha = head();
        await snapshotForScan(
          { provider, repo: 'acme/app', commitSha: sha },
          async () => undefined,
        );
        await (db as never as { insert: (t: unknown) => { values: (r: Row) => unknown } })
          .insert(security.scanRuns)
          .values({
            workspaceId: 1,
            repoId: 2,
            scannerKey: key,
            commitSha: s.commitSha ?? sha,
            trigger: 'manual',
            status: 'succeeded',
            toolVersions: s.toolVersions,
            dataVersion: s.dataVersion,
            finishedAt: new Date(),
          });
        ran.push(key);
        return { scanned: 1, findingsCreated: 0, deferred: 0 };
      };
    /** What a no-tarball, always-run runner does: its own SQL or forge read. */
    const cheapRunner = (key: string) => async () => {
      ran.push(key);
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    };

    const rules = () => ruleStateStamp(db, 1);
    const weeklyRunners = {
      semgrep: snapshotRunner('semgrep', async () => ({
        toolVersions: { opengrep: '1.8.2', rulepack: 'r.yaml' },
        dataVersion: semgrepDataVersion(undefined, undefined, await rules()),
      })),
      code_health_tools: snapshotRunner('code_health_tools', async () => ({
        toolVersions: { lizard: '1.24.0', jscpd: '4.3.0', ruff: '0.6.0' },
        dataVersion: codeHealthDataVersion(undefined, await rules()),
      })),
      dependency_cve: snapshotRunner('dependency_cve', async () => ({
        toolVersions: { syft: '1.4.1', grype: '0.80.0' },
        dataVersion: dependencyDataVersion(),
      })),
      container_image: snapshotRunner('container_image', async () => ({
        toolVersions: { grype: '0.80.0' },
        dataVersion: imageDataVersion(),
      })),
      anti_slop: snapshotRunner('anti_slop', async () => ({
        toolVersions: { opengrep: '1.8.2', rulepack: 'slop.yaml' },
        dataVersion: antiSlopDataVersion('off', await rules()),
      })),
      architecture_register: snapshotRunner('architecture_register', async () => ({
        toolVersions: null,
        dataVersion: architectureDataVersion(),
      })),
      supply_chain_register: snapshotRunner('supply_chain_register', async () => {
        const stamp = await supplyChainDataVersion(db, 1, 2);
        return { toolVersions: null, dataVersion: stamp!.dataVersion, commitSha: stamp!.commitSha };
      }),
      // The always-run set: none of them fetches a tarball.
      knowledge_register: cheapRunner('knowledge_register'),
      test_gap_register: cheapRunner('test_gap_register'),
      attack_chainer: cheapRunner('attack_chainer'),
      code_scanning_pull: cheapRunner('code_scanning_pull'),
      owasp_web: cheapRunner('owasp_web'),
      owasp_llm: cheapRunner('owasp_llm'),
    };
    const SNAPSHOT_KEYS = [
      'semgrep',
      'code_health_tools',
      'dependency_cve',
      'container_image',
      'anti_slop',
      'architecture_register',
      'supply_chain_register',
    ];
    const process = scanProcessor({
      db,
      weeklyRunners,
      // The real probes, with the worker's gateway answer for anti-slop.
      probes: buildScanProbes(db, { antiSlopJudgement: async () => 'off' }),
    });

    /** "Run scans now": one manual job per enabled scanner. */
    const press = async (extra: Partial<ScanJobData> = {}) => {
      for (const key of Object.keys(weeklyRunners)) {
        await process({ data: job({ scannerKey: key, ...extra }) } as never);
      }
    };
    const skippedRows = () =>
      rows(security.scanRuns)
        .filter((r) => r['scope'] === 'skipped')
        .map((r) => r['scannerKey']);

    // Press 1: nothing has ever run, so every snapshot scanner fetches its tarball.
    await press();
    expect(fetches).toHaveLength(SNAPSHOT_KEYS.length);
    expect(skippedRows()).toEqual([]);

    // Press 2, no new commit: ZERO new fetches across all enabled scanners.
    await press();
    expect(fetches).toHaveLength(SNAPSHOT_KEYS.length);
    expect([...skippedRows()].sort()).toEqual([...SNAPSHOT_KEYS].sort());
    // The skipped rows stand on real runs at the real commit.
    for (const row of rows(security.scanRuns).filter((r) => r['scope'] === 'skipped')) {
      expect(row['baseRunId'], String(row['scannerKey'])).toBeTypeOf('number');
      expect(row['status']).toBe('succeeded');
    }
    // The always-run scanners ran both times (and cost no fetch).
    expect(ran.filter((k) => k === 'knowledge_register')).toHaveLength(2);

    // CONTROL 1: a pushed commit is a new question for every one of them.
    rows(facts.commits).unshift({ sha: HEAD2 });
    await press();
    expect(fetches).toHaveLength(SNAPSHOT_KEYS.length * 2);

    // CONTROL 2: "Full rescan" bypasses the check at an unchanged commit.
    await press({ force: true });
    expect(fetches).toHaveLength(SNAPSHOT_KEYS.length * 3);

    // Nothing but the archive was ever asked of the forge.
    expect(portCalls).toHaveLength(fetches.length);
  });
});
