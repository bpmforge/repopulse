import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxArgs, sandboxEnv, SCAN_MOUNT_PATH } from './profile.js';
import { parseSandboxOutput, runInSandbox } from './run.js';

// Sandbox profile + runner (W8-03, SECURITY_SUITE.md 2.2, NFR-14).

const budget = { wallClockMs: 60_000, forgeCalls: 0, llmTokens: 0, memoryMb: 512, cpuMillis: 2000 };

function args(over: Partial<Parameters<typeof buildSandboxArgs>[0]> = {}): string[] {
  return buildSandboxArgs({
    image: 'localhost/repopulse/scan:test',
    snapshotDir: '/scratch/snap-abc',
    command: ['scan', '--json'],
    budget,
    ...over,
  });
}

describe('sandbox profile (NFR-14)', () => {
  it('denies the network, the filesystem and privilege, all explicitly', () => {
    const argv = args();
    expect(argv).toContain('--network=none');
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--cap-drop=ALL');
    expect(argv).toContain('--security-opt=no-new-privileges');
    expect(argv).toContain('--user=65534:65534');
    expect(argv).toContain('--pids-limit=256');
  });

  it('mounts the snapshot read-only AND noexec', () => {
    // A repository is full of executable files someone else wrote; a scanner
    // reads them and must never run them.
    expect(args()).toContain(`--volume=/scratch/snap-abc:${SCAN_MOUNT_PATH}:ro,noexec`);
  });

  it('carries the ScanBudget onto the container as real limits', () => {
    const argv = args();
    expect(argv).toContain('--memory=512m');
    expect(argv).toContain('--cpus=2.00');
    // Podman's own kill switch, so a container outlives neither its budget nor
    // this process.
    expect(argv).toContain('--timeout=60');
  });

  it('passes NO environment at all - not a filtered copy of ours', () => {
    // A denylist of secret-looking names is a guess about what the next wave
    // will put in the environment. An empty env is not a guess.
    expect(sandboxEnv()).toEqual({});
    expect(args().some((a) => a.startsWith('--env') || a === '-e')).toBe(false);
  });

  it('never leaks a credential-shaped value into the argv', () => {
    const argv = args().join(' ');
    for (const secret of ['TOKEN', 'SECRET', 'PASSWORD', 'ANTHROPIC', 'DATABASE_URL']) {
      expect(argv.toUpperCase()).not.toContain(secret);
    }
  });

  it('puts the image and its command last, after every flag', () => {
    const argv = args();
    expect(argv.slice(-3)).toEqual(['localhost/repopulse/scan:test', 'scan', '--json']);
  });
});

describe('sandbox output handling', () => {
  it('rejects anything that is not the findings schema', () => {
    // The tool is parsing attacker-influenced source, so its output is
    // downstream of the same input the sandbox exists to contain.
    expect(parseSandboxOutput('').ok).toBe(false);
    expect(parseSandboxOutput('not json').ok).toBe(false);
    expect(parseSandboxOutput('{"findings":[{"ruleId":""}]}').ok).toBe(false);
  });

  it('accepts a well-formed findings document', () => {
    const parsed = parseSandboxOutput(
      JSON.stringify({
        findings: [
          {
            ruleId: 'r1',
            file: 'a.ts',
            lineStart: 1,
            lineEnd: 2,
            severity: 3,
            title: 't',
            evidence: 'e',
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('a scanner whose output cannot be validated produced NO findings, not zero', async () => {
    // The distinction that keeps a broken scanner from rendering a repo clean.
    const result = await runInSandbox({
      image: 'x',
      snapshotDir: '/tmp/x',
      command: ['echo'],
      budget,
      runtime: process.execPath,
      // Stands in for a scan tool that exits 0 with junk on stdout.
      spawnFn: ((_cmd: string, _argv: string[], opts: object) =>
        realSpawn(process.execPath, ['-e', 'process.stdout.write("garbage")'], opts)) as never,
    });
    expect(result.status).toBe('invalid_output');
    expect(result.output).toBeUndefined();
  });
});

const { spawn: realSpawn } = await import('node:child_process');

// The live half. Podman is a hard requirement for a scan to run at all, so an
// absent runtime is a skip with a reason rather than a silent pass - but the
// argv assertions above still run everywhere, which is what keeps the profile
// honest on a machine without a container runtime.
const podmanAvailable = (() => {
  try {
    execFileSync('podman', ['info', '--format', '{{.Host.Arch}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const localImage = (() => {
  if (!podmanAvailable) return undefined;
  const out = execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
    stdio: 'pipe',
  }).toString();
  // Any local image with a shell will do - this asserts the PROFILE, not a
  // particular scanner. Pulling one would need network, which is the thing
  // under test.
  return out
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s !== '' && !s.includes('<none>'));
})();

const describeIfPodman = podmanAvailable && localImage ? describe : describe.skip;

describeIfPodman('sandbox, actually run (NFR-14)', () => {
  const image = localImage as string;

  function snapshotDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'w8-03-scan-'));
    writeFileSync(path.join(dir, 'source.ts'), 'export const a = 1;\n');
    return dir;
  }

  it('can read the snapshot', async () => {
    const dir = snapshotDir();
    const out = execFileSync(
      'podman',
      buildSandboxArgs({
        image,
        snapshotDir: dir,
        command: ['sh', '-c', 'cat /scan/source.ts'],
        budget,
      }),
      { stdio: 'pipe' },
    ).toString();
    expect(out).toContain('export const a = 1;');
  }, 30_000);

  it('CANNOT write to the snapshot, and cannot reach the network', () => {
    const dir = snapshotDir();
    const run = (script: string): string => {
      try {
        return execFileSync(
          'podman',
          buildSandboxArgs({ image, snapshotDir: dir, command: ['sh', '-c', script], budget }),
          { stdio: 'pipe' },
        ).toString();
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer };
        return `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
      }
    };

    // Read-only mount: the write must fail, and the file must not appear.
    expect(run('echo x > /scan/written.txt 2>&1 || echo WRITE_DENIED')).toContain('WRITE_DENIED');
    // --network=none: the container's routing table holds nothing but the
    // loopback device, so there is nowhere to send anything. Asserted by
    // reading /proc/net/route rather than by attempting a connection - a
    // connection attempt that hangs on a resolver timeout proves nothing and
    // takes ten seconds to prove it.
    const routes = run('cat /proc/net/route');
    // Guard against the vacuous pass: if the read itself failed there would be
    // no interfaces either, and this test would "prove" network denial by
    // proving nothing.
    expect(routes).toContain('Iface');
    const ifaces = routes
      .split('\n')
      .slice(1)
      .map((line) => line.split(/\s+/)[0])
      .filter((name) => name !== undefined && name !== '');
    expect(ifaces.filter((name) => name !== 'lo')).toEqual([]);
  }, 30_000);

  it('runs as a non-root user', () => {
    const dir = snapshotDir();
    const out = execFileSync(
      'podman',
      buildSandboxArgs({ image, snapshotDir: dir, command: ['id', '-u'], budget }),
      { stdio: 'pipe' },
    ).toString();
    expect(out.trim()).not.toBe('0');
  }, 30_000);
});
