import { beforeEach, describe, expect, it, vi } from 'vitest';

// W22-07: the third-party pack rides along with OUR security pack and nothing
// else. The sandbox is stubbed so the test reads the command the engine would
// have been given.

const calls: { command: string[]; extraMounts: { containerPath: string }[] }[] = [];

vi.mock('../../../sandbox/run.js', () => ({
  runInSandbox: vi.fn(
    async (opts: { command: string[]; extraMounts: { containerPath: string }[] }) => {
      calls.push(opts);
      return {
        status: 'succeeded',
        exitCode: 0,
        stderr: '',
        durationMs: 1,
        rawStdout: JSON.stringify({ results: [], errors: [], paths: { scanned: [] } }),
      };
    },
  ),
  stderrTail: (s: string) => s,
}));

const { runSemgrepScan, SEMGREP_RULEPACK_DIR } = await import('./scanner.js');
const { readThirdPartyPack, THIRD_PARTY_MOUNT_PATH } = await import('../../rules/third-party.js');

const configsUnder = (command: string[], mount: string) =>
  command.filter((arg, i) => command[i - 1] === '--config' && arg.startsWith(`${mount}/`));

describe('third-party pack in a semgrep run (W22-07)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('a default security run mounts the pack and passes every ledger file', async () => {
    const result = await runSemgrepScan({
      targetDir: '/tmp/none',
      budget: { wallClockMs: 1000 },
      thirdParty: true,
    });
    const call = calls[0]!;
    expect(call.extraMounts.map((m) => m.containerPath)).toContain(THIRD_PARTY_MOUNT_PATH);
    expect(configsUnder(call.command, THIRD_PARTY_MOUNT_PATH)).toHaveLength(
      readThirdPartyPack()!.files.length,
    );
    expect(result.toolVersions['thirdParty']).toMatch(/^ledger:/);
  });

  it('is off by default, and an explicit file selection leaves it out', async () => {
    await runSemgrepScan({ targetDir: '/tmp/none', budget: { wallClockMs: 1000 } });
    await runSemgrepScan({
      thirdParty: true,
      targetDir: '/tmp/none',
      budget: { wallClockMs: 1000 },
      rulepackDir: SEMGREP_RULEPACK_DIR,
      rulepackFiles: (f) => f.endsWith('c-cpp.v1.yaml'),
    });
    await runSemgrepScan({
      targetDir: '/tmp/none',
      budget: { wallClockMs: 1000 },
      thirdParty: false,
    });
    for (const call of calls) {
      expect(configsUnder(call.command, THIRD_PARTY_MOUNT_PATH)).toEqual([]);
      expect(call.extraMounts.map((m) => m.containerPath)).not.toContain(THIRD_PARTY_MOUNT_PATH);
    }
  });
});
