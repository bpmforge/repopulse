import { readFileSync } from 'node:fs';
import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { scannerRuns } from '../lib/scan-schedule.js';
import { expectedAtHead, prScannerKeys, PR_SCANNER_KEYS } from '../routes/pulls/new-findings.js';
import { scanProcessor, type ScanJobData } from './scan-processor.js';

// W21-02: the pattern scanners on every PR push — the wiring, the waiting rule
// and the words. The scans themselves are covered in packages/security
// (scanners/pr/run.integration.test.ts).

vi.mock('./forge-provider.js', () => ({
  providerForRepo: async () => ({ provider: {}, repoFullName: 'acme/app' }),
  providerForConnection: async () => null,
}));
vi.mock('@repopulse/ingest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repopulse/ingest')>()),
  processDeltaJob: async () => ({ applied: 1 }),
}));

const { deltaProcessor } = await import('./processors.js');

const queue = {} as Queue;
const deltaDeps = (
  queuePrScans: (ws: number, repo: number) => Promise<{ queued: number; deferred: number }>,
) => ({
  db: {} as never,
  tokenKey: Buffer.alloc(32),
  backfillQueue: queue,
  snapshotQueue: queue,
  enrichQueue: queue,
  reconcileQueue: queue,
  queuePrScans,
});

describe('a PR delta queues the pattern scanners (W21-02)', () => {
  it('asks for PR scans on a pull_requests delta, and only then', async () => {
    const asked: [number, number][] = [];
    const run = deltaProcessor(
      deltaDeps(async (ws, repo) => {
        asked.push([ws, repo]);
        return { queued: 2, deferred: 1 };
      }),
    );
    const pr = await run({ data: { workspaceId: 1, repoId: 7, kind: 'pull_requests' } } as Job);
    expect(asked).toEqual([[1, 7]]);
    expect(pr).toMatchObject({ prScans: { queued: 2, deferred: 1 } });
    await run({ data: { workspaceId: 1, repoId: 7, kind: 'push_commits' } } as Job);
    expect(asked).toHaveLength(1);
  });

  it('never fails ingestion because queueing failed', async () => {
    const run = deltaProcessor(
      deltaDeps(async () => {
        throw new Error('redis is down');
      }),
    );
    const out = await run({ data: { workspaceId: 1, repoId: 7, kind: 'pull_requests' } } as Job);
    expect(out).toMatchObject({ prScans: { error: 'redis is down' } });
  });

  it('the worker entrypoint wires the queueing and the runner, keyed by head', () => {
    const entry = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    expect(entry).toContain('queuePrScans:');
    expect(entry).toContain('pendingPrPatternTargets(');
    expect(entry).toContain('runPrPatternScans(');
    expect(entry).toContain('jobId: `sec-pr-${repoId}-${t.commitSha}`');
    expect(entry).toContain("process.env.PR_SCANS !== 'off'");
    // No model on a push: the PR runner hands no gateway to anything.
    const runner = entry.slice(entry.indexOf('prRunner:'), entry.indexOf('historyRunners:'));
    expect(runner).not.toMatch(/gateway/i);
  });

  it('the scan lane runs a pr job through the injected runner', async () => {
    const seen: ScanJobData[] = [];
    const process = scanProcessor({
      db: {} as never,
      prRunner: async (data) => {
        seen.push(data);
      },
    });
    const data: ScanJobData = {
      workspaceId: 1,
      repoId: 7,
      scannerKey: 'pr_patterns',
      commitSha: 'abc',
      prNumber: 4,
      trigger: 'pr_synced',
      mode: 'pr',
    };
    await process({ data } as Job<ScanJobData>);
    expect(seen).toEqual([data]);
  });
});

describe('what the CI pull waits for (W21-02, X-13)', () => {
  it('lists the pattern scanners as PR scanners', () => {
    for (const k of [
      'secrets',
      'sensitive_change',
      'semgrep',
      'anti_slop',
      'logging_hygiene',
      'performance',
      'dependency_cve',
      'container_image',
    ]) {
      expect(PR_SCANNER_KEYS, k).toContain(k);
    }
    // W21-05: slopsquat rides the secrets stream on every push.
    expect(PR_SCANNER_KEYS).toContain('slopsquat');
    // Weekly-only scanners are not.
    expect(PR_SCANNER_KEYS).not.toContain('code_health_tools');
  });

  it('waits for a conditional scanner only once it has started at the head', () => {
    const enabled = ['secrets', 'semgrep', 'dependency_cve', 'container_image'];
    expect(expectedAtHead(enabled, new Set())).toEqual(['secrets', 'semgrep']);
    expect(expectedAtHead(enabled, new Set(['dependency_cve']))).toEqual([
      'secrets',
      'semgrep',
      'dependency_cve',
    ]);
  });

  it('does not wait for pattern scanners a server has switched off for PRs', () => {
    const off = prScannerKeys({ PR_SCANS: 'off' } as NodeJS.ProcessEnv);
    expect([...off].sort()).toEqual(['secrets', 'sensitive_change', 'slopsquat']);
    expect(prScannerKeys({} as NodeJS.ProcessEnv)).toBe(PR_SCANNER_KEYS);
  });
});

describe('the Coverage table says when they run (W21-02)', () => {
  const wed = new Date(2026, 9, 21, 12, 0);
  const env = {} as NodeJS.ProcessEnv;
  it('names pull-request pushes for the pattern scanners', () => {
    expect(scannerRuns('semgrep', ['pr_synced', 'schedule', 'manual'], env, wed).text).toMatch(
      /^on every pull request push; weekly, next Sun 25 Oct 02:41 \(server time\); or by hand$/,
    );
    expect(
      scannerRuns('dependency_cve', ['pr_synced', 'schedule', 'manual'], env, wed).text,
    ).toMatch(/^on pull requests that change a manifest or lockfile; weekly/);
    expect(scannerRuns('container_image', ['pr_synced', 'manual'], env, wed).text).toBe(
      'on pull requests that change a file naming an image; or by hand',
    );
    // Logging and performance ride the weekly anti-slop run.
    expect(scannerRuns('performance', ['pr_synced', 'schedule'], env, wed).cron).toBe('41 2 * * 0');
  });
  it('drops the PR wording when PR_SCANS is off', () => {
    const r = scannerRuns(
      'semgrep',
      ['pr_synced', 'schedule', 'manual'],
      {
        PR_SCANS: 'off',
      } as NodeJS.ProcessEnv,
      wed,
    );
    expect(r.on_change).toBe(false);
    expect(r.text).toMatch(/^weekly/);
  });
});
