import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDockerArgs,
  buildPodmanArgs,
  buildSandboxArgs,
  runtimeEnv,
  runtimeFlavour,
  SCAN_CONTAINER_LABEL,
  SCAN_MOUNT_PATH,
  scanContainerName,
} from './profile.js';
import { parseSandboxOutput, runInSandbox, stderrTail } from './run.js';

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
    // this process — set a margin ABOVE the runner's timer so it never wins
    // the race and turns a timeout into a plain failure.
    expect(argv).toContain('--timeout=65');
  });

  it('gives the RUNTIME a PATH and the container nothing (W8-12)', () => {
    // Two different environments, and conflating them broke the first version:
    // an empty env means podman itself cannot be found. What matters is that
    // no --env flag hands the container anything of ours; the live test below
    // proves the host environment does not reach inside.
    expect(Object.keys(runtimeEnv())).toEqual(['PATH']);
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

// Two runtimes, two builders (W17-27, acceptance 4). The RP-01 probe found the
// single builder pushing podman's `--timeout` at docker, which `docker run`
// rejects — so every tool-based scan on a docker host failed before the
// container existed. Each builder is now asserted against the flag set its
// runtime documents, and the shared boundary is asserted on both.
describe('podman vs docker argv (W17-27)', () => {
  const profile = {
    image: 'localhost/repopulse/scan:test',
    snapshotDir: '/scratch/snap-abc',
    command: ['scan', '--json'] as const,
    budget,
    extraMounts: [{ hostPath: '/rules/pack', containerPath: '/rules' }],
    writablePaths: ['/opt/opengrep/.opengrep'],
    containerName: 'repopulse-scan-t1',
  };

  const SHARED = [
    'run',
    '--rm',
    '--name=repopulse-scan-t1',
    `--label=${SCAN_CONTAINER_LABEL}`,
    '--network=none',
    '--read-only',
    '--user=65534:65534',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    '--pids-limit=256',
    `--workdir=${SCAN_MOUNT_PATH}`,
    '--memory=512m',
    '--cpus=2.00',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=256m,mode=1777',
    '--tmpfs=/opt/opengrep/.opengrep:rw,noexec,nosuid,size=16m,mode=1777',
  ];

  it('both builders carry the whole boundary, the image and the command', () => {
    for (const argv of [buildPodmanArgs(profile), buildDockerArgs(profile)]) {
      for (const flag of SHARED) expect(argv).toContain(flag);
      expect(argv.slice(-3)).toEqual(['localhost/repopulse/scan:test', 'scan', '--json']);
      expect(argv.some((a) => a.startsWith('--env') || a === '-e')).toBe(false);
    }
  });

  it('podman: ro,noexec binds and the --timeout backstop', () => {
    const argv = buildPodmanArgs(profile);
    expect(argv).toContain(`--volume=/scratch/snap-abc:${SCAN_MOUNT_PATH}:ro,noexec`);
    expect(argv).toContain('--volume=/rules/pack:/rules:ro,noexec');
    expect(argv).toContain('--timeout=65');
  });

  it('docker: --mount readonly binds and NO --timeout, which docker run rejects', () => {
    const argv = buildDockerArgs(profile);
    expect(argv).toContain(
      `--mount=type=bind,source=/scratch/snap-abc,target=${SCAN_MOUNT_PATH},readonly`,
    );
    expect(argv).toContain('--mount=type=bind,source=/rules/pack,target=/rules,readonly');
    expect(argv.some((a) => a.startsWith('--timeout'))).toBe(false);
    // docker's bind mounts cannot say noexec; asserting the absence is what
    // stops someone "fixing" the builder with a flag docker will refuse.
    expect(argv.some((a) => a.startsWith('--volume'))).toBe(false);
    expect(argv.some((a) => a.includes('noexec') && a.includes('bind'))).toBe(false);
  });

  it('picks the builder from the runtime binary name, path or wrapper included', () => {
    expect(runtimeFlavour('podman')).toBe('podman');
    expect(runtimeFlavour('podman-remote')).toBe('podman');
    expect(runtimeFlavour('/opt/homebrew/bin/podman')).toBe('podman');
    expect(runtimeFlavour('docker')).toBe('docker');
    expect(runtimeFlavour('/usr/bin/docker')).toBe('docker');
    expect(buildSandboxArgs(profile, 'docker')).toEqual(buildDockerArgs(profile));
    expect(buildSandboxArgs(profile)).toEqual(buildPodmanArgs(profile));
  });

  it('names every run uniquely so a timed-out container can be removed by name', () => {
    const a = scanContainerName(() => 1_700_000_000_000);
    const b = scanContainerName(() => 1_700_000_000_000);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^repopulse-scan-[a-z0-9-]+$/);
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
  const images = out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.includes('<none>'));
  // Prefer the real scan image (W8-12) when it has been built: asserting the
  // profile against the image scanners actually run in is worth more than
  // asserting it against whatever happened to be on the machine.
  return images.find((s) => s.startsWith('localhost/repopulse/scan:')) ?? images[0];
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

  it('runs the REAL scan tool under the REAL profile (W8-12)', () => {
    // Skipped unless the scan image is present, because that is the only image
    // with opengrep in it. This is the assertion the sandbox exists for: the
    // tool runs with no network, a read-only root, an unprivileged user and a
    // ro,noexec source mount — and it took three failures to get there, each
    // of which is recorded in Containerfile.scan rather than fixed by
    // loosening the profile.
    if (!image.startsWith('localhost/repopulse/scan:')) return;
    const dir = snapshotDir();
    const out = execFileSync(
      'podman',
      buildSandboxArgs({
        image,
        snapshotDir: dir,
        command: ['opengrep', '--version'],
        budget,
        // The tool's log directory, declared by the caller rather than assumed
        // by the profile.
        writablePaths: ['/opt/opengrep/.opengrep'],
      }),
      { stdio: 'pipe' },
    ).toString();
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 120_000);

  it('does NOT leak the host environment into the container', () => {
    // The claim the profile makes, checked rather than asserted in a comment:
    // a secret-shaped variable set beside the run must not be visible inside.
    const dir = snapshotDir();
    const out = execFileSync(
      'podman',
      buildSandboxArgs({ image, snapshotDir: dir, command: ['env'], budget }),
      { stdio: 'pipe', env: { ...process.env, REPOPULSE_TEST_SECRET: 'must-not-appear' } },
    ).toString();
    expect(out).not.toContain('must-not-appear');
    expect(out).not.toContain('REPOPULSE_TEST_SECRET');
  }, 30_000);
});

describe('stderrTail (W16-37)', () => {
  it('returns the LAST lines, where a dying tool puts its reason', () => {
    expect(stderrTail('[0000] INFO working\n[0000] ERROR the real reason\n')).toBe(
      '[0000] INFO working [0000] ERROR the real reason',
    );
  });

  it('is empty for empty stderr, so a caller can tell there is nothing to add', () => {
    expect(stderrTail('')).toBe('');
    expect(stderrTail('   \n  \n')).toBe('');
  });

  it('marks a truncation instead of cutting mid-word', () => {
    // The first version sliced bare and produced "epopulse/does-not-exist",
    // which reads as a rendering bug rather than as a truncation.
    const long = `x${'y'.repeat(400)}`;
    const out = stderrTail(long, 2, 50);
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBe(51);
  });

  it('keeps a short message whole, with no ellipsis', () => {
    expect(stderrTail('exit 125', 2, 300)).toBe('exit 125');
  });
});
