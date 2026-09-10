import { execFileSync, spawn as realSpawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInSandbox } from './run.js';
import { buildSandboxArgs } from './profile.js';
import { runnerStatus, runViaRunner } from './runner-client.js';
import { runnerStatusSchema, type RunnerRequest } from './runner-protocol.js';
import {
  createRunnerServer,
  listenOnSocket,
  runnerConfigFromEnv,
  RunnerRefusal,
  runtimeGlobalArgs,
  ScanRunner,
  type RunnerConfig,
} from './runner-server.js';

// The scan-runner boundary (W17-27).
//
// The unit half asserts what the runner REFUSES and how it translates paths,
// with the runtime stubbed. The live half drives a real podman through the
// runner over a real unix socket and proves the four cleanup cases the ticket
// names: success, timeout, error, restart.

const IMAGE = 'localhost/repopulse/scan:test';
const ROOT = '/var/tmp/repopulse-scan';
const RULES = '/var/lib/repopulse/scan-rules';

function config(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    runtime: 'podman',
    runtimeBinary: 'podman-remote',
    containerSocket: '/run/container.sock',
    image: IMAGE,
    snapshotRoot: ROOT,
    scratch: { mode: 'volume', volume: 'repopulse-scan-scratch' },
    rulesDir: RULES,
    rulesHostDir: '/srv/repopulse/scan-rules',
    maxWallClockMs: 60_000,
    queryFn: async (args) => {
      if (args[0] === 'volume')
        return '/var/lib/containers/storage/volumes/repopulse-scan-scratch/_data';
      if (args[0] === 'ps') return '';
      if (args[0] === 'version') return '5.8.2';
      if (args[0] === 'image') return 'sha256:abc';
      throw new Error(`unexpected query ${args.join(' ')}`);
    },
    log: () => {},
    // The unit half has no real snapshot to stat; "root-owned" exercises the
    // profile default. The owner case has its own test below.
    statFn: () => null,
    ...over,
  };
}

function request(over: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    image: IMAGE,
    snapshotDir: `${ROOT}/snap-abc123`,
    command: ['opengrep', 'scan', '--json'],
    budget: { wallClockMs: 30_000, memoryMb: 512, cpuMillis: 2000 },
    ...over,
  };
}

describe('runner configuration', () => {
  it('refuses to start without a scratch it can translate', () => {
    expect(() => runnerConfigFromEnv({ SCAN_IMAGE: 'x' })).toThrow(/SCAN_SCRATCH_VOLUME/);
  });

  it('reaches podman through podman-remote --url when given a socket, docker through -H', () => {
    const podman = runnerConfigFromEnv({
      CONTAINER_SOCKET: '/run/container.sock',
      SCAN_SCRATCH_VOLUME: 'v',
    });
    expect(podman.runtime).toBe('podman');
    expect(podman.runtimeBinary).toBe('podman-remote');
    expect(runtimeGlobalArgs(podman)).toEqual(['--url', 'unix:///run/container.sock']);

    const docker = runnerConfigFromEnv({
      SCAN_RUNTIME: 'docker',
      CONTAINER_SOCKET: '/var/run/docker.sock',
      SCAN_SCRATCH_VOLUME: 'v',
    });
    expect(docker.runtimeBinary).toBe('docker');
    expect(runtimeGlobalArgs(docker)).toEqual(['-H', 'unix:///var/run/docker.sock']);

    // No socket: the local CLI, addressed the way a dev checkout addresses it.
    const local = runnerConfigFromEnv({ SCAN_SCRATCH_HOST_DIR: '/tmp/scratch' });
    expect(local.runtimeBinary).toBe('podman');
    expect(runtimeGlobalArgs(local)).toEqual([]);
    expect(local.scratch).toEqual({ mode: 'bind', hostDir: '/tmp/scratch' });
  });
});

describe('what the runner refuses', () => {
  const runner = new ScanRunner(config());

  const refuses = async (req: RunnerRequest, pattern: RegExp): Promise<void> => {
    await expect(runner.toProfile(req)).rejects.toBeInstanceOf(RunnerRefusal);
    await expect(runner.toProfile(req)).rejects.toThrow(pattern);
  };

  it('any image but its own', async () => {
    await refuses(
      request({ image: 'docker.io/library/alpine:3.20' }),
      /not this runner's SCAN_IMAGE/,
    );
  });

  it('a snapshot outside the scratch root, nested, traversing, or not snap-*', async () => {
    await refuses(request({ snapshotDir: '/etc' }), /snapshotDir/);
    await refuses(request({ snapshotDir: `${ROOT}/snap-a/deeper` }), /snapshotDir/);
    await refuses(request({ snapshotDir: `${ROOT}/snap-a/../../etc` }), /snapshotDir/);
    await refuses(request({ snapshotDir: `${ROOT}/other-abc` }), /snapshotDir/);
    await refuses(request({ snapshotDir: ROOT }), /snapshotDir/);
  });

  it('an extra mount from anywhere but the rules dir, or onto the image tree', async () => {
    await refuses(
      request({ extraMounts: [{ hostPath: '/etc', containerPath: '/rules' }] }),
      /outside the rules dir/,
    );
    await refuses(
      request({ extraMounts: [{ hostPath: `${RULES}/../secrets`, containerPath: '/rules' }] }),
      /outside the rules dir/,
    );
    await refuses(
      request({
        extraMounts: [{ hostPath: `${RULES}/rulepacks`, containerPath: '/usr/local/bin' }],
      }),
      /may not target/,
    );
    await refuses(
      request({ extraMounts: [{ hostPath: `${RULES}/rulepacks`, containerPath: '/scan' }] }),
      /may not target/,
    );
  });

  it('root, and a wall clock over its cap', async () => {
    await refuses(request({ user: '0:0' }), /uid 0/);
    await refuses(request({ budget: { wallClockMs: 60_001 } }), /exceeds the runner's cap/);
  });

  it('a writable path over the snapshot or the kernel', async () => {
    await refuses(request({ writablePaths: ['/scan'] }), /writable path/);
    await refuses(request({ writablePaths: ['/proc/sys'] }), /writable path/);
  });
});

describe('how the runner translates a request', () => {
  it('derives every host path from its own configuration, never from the request', async () => {
    const runner = new ScanRunner(config());
    const profile = await runner.toProfile(
      request({
        extraMounts: [
          { hostPath: `${RULES}/rulepacks/semgrep`, containerPath: '/rules' },
          { hostPath: `${RULES}/vuln-db`, containerPath: '/vuln-db' },
        ],
        writablePaths: ['/opt/opengrep/.opengrep'],
      }),
    );
    expect(profile.snapshotDir).toBe(
      '/var/lib/containers/storage/volumes/repopulse-scan-scratch/_data/snap-abc123',
    );
    expect(profile.extraMounts).toEqual([
      { hostPath: '/srv/repopulse/scan-rules/rulepacks/semgrep', containerPath: '/rules' },
      { hostPath: '/srv/repopulse/scan-rules/vuln-db', containerPath: '/vuln-db' },
    ]);
    expect(profile.writablePaths).toEqual(['/opt/opengrep/.opengrep']);
    expect(profile.image).toBe(IMAGE);
    expect(profile.containerName).toMatch(/^repopulse-scan-/);
  });

  it('runs the scan as the uid:gid that owns the snapshot, unless the request names a user', async () => {
    // The worker extracts 0700/0600 as its own uid; nobody (65534) in the scan
    // container cannot read that. Measured on the packaged stack (W17-27).
    const seen: string[] = [];
    const runner = new ScanRunner(
      config({
        statFn: (dir) => {
          seen.push(dir);
          return '100:101';
        },
      }),
    );
    const owned = await runner.toProfile(request());
    expect(owned.user).toBe('100:101');
    // Stat'd through the runner's OWN mount, at the worker's path — never the
    // daemon's host path, which this process cannot see.
    expect(seen).toEqual([`${ROOT}/snap-abc123`]);

    const explicit = await runner.toProfile(request({ user: '2000:2000' }));
    expect(explicit.user).toBe('2000:2000');

    // Root-owned or unreadable: fall through to the profile default, which
    // buildSandboxArgs spells as 65534.
    const fallback = await new ScanRunner(config({ statFn: () => null })).toProfile(request());
    expect(fallback.user).toBeUndefined();
    expect(buildSandboxArgs(fallback)).toContain('--user=65534:65534');
  });

  it('in bind mode the scratch host dir is used as-is, with no volume lookup', async () => {
    const runner = new ScanRunner(
      config({
        scratch: { mode: 'bind', hostDir: '/srv/scratch' },
        queryFn: async () => {
          throw new Error('must not query');
        },
      }),
    );
    const profile = await runner.toProfile(request());
    expect(profile.snapshotDir).toBe('/srv/scratch/snap-abc123');
  });

  it('spawns the runtime with the socket flags first, then the profile for THAT runtime', async () => {
    const calls: { cmd: string; argv: string[] }[] = [];
    const spawnFn = ((cmd: string, argv: string[], opts: object) => {
      calls.push({ cmd, argv });
      return realSpawn(process.execPath, ['-e', 'process.stdout.write("{}")'], opts);
    }) as never;

    const podman = new ScanRunner(config({ spawnFn }));
    await podman.run(request());
    expect(calls[0]?.cmd).toBe('podman-remote');
    expect(calls[0]?.argv.slice(0, 3)).toEqual(['--url', 'unix:///run/container.sock', 'run']);
    expect(calls[0]?.argv).toContain('--timeout=30');
    expect(calls[0]?.argv.some((a) => a.startsWith('--name=repopulse-scan-'))).toBe(true);

    const docker = new ScanRunner(
      config({
        spawnFn,
        runtime: 'docker',
        runtimeBinary: 'docker',
        containerSocket: '/var/run/docker.sock',
      }),
    );
    await docker.run(request());
    expect(calls[1]?.cmd).toBe('docker');
    expect(calls[1]?.argv.slice(0, 3)).toEqual(['-H', 'unix:///var/run/docker.sock', 'run']);
    expect(calls[1]?.argv.some((a) => a.startsWith('--timeout'))).toBe(false);
    expect(calls[1]?.argv.some((a) => a.startsWith('--mount=type=bind'))).toBe(true);
  });

  it('on timeout, removes the container BY NAME and waits for that before answering', async () => {
    const calls: string[][] = [];
    const spawnFn = ((cmd: string, argv: string[], opts: object) => {
      calls.push([cmd, ...argv]);
      // `run` hangs; `rm` returns at once.
      const script = argv.includes('rm') ? 'process.exit(0)' : 'setTimeout(() => {}, 60000)';
      return realSpawn(process.execPath, ['-e', script], opts);
    }) as never;
    const runner = new ScanRunner(config({ spawnFn }));
    const result = await runner.run(request({ budget: { wallClockMs: 300 } }));
    expect(result.status).toBe('timed_out');
    const rm = calls.find((c) => c.includes('rm'));
    expect(rm).toBeDefined();
    const name = calls[0]?.find((a) => a.startsWith('--name='))?.slice('--name='.length);
    expect(rm).toEqual([
      'podman-remote',
      '--url',
      'unix:///run/container.sock',
      'rm',
      '--force',
      name,
    ]);
  });
});

describe('over the socket', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w17-27-sock-'));
  // macOS caps a unix socket path at 104 bytes; keep the name short.
  const socketPath = path.join(dir, 's');
  const spawned: string[][] = [];
  const spawnFn = ((cmd: string, argv: string[], opts: object) => {
    spawned.push([cmd, ...argv]);
    return realSpawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify({findings:[]}))'],
      opts,
    );
  }) as never;
  const runner = new ScanRunner(config({ spawnFn }));
  const server = createRunnerServer(runner);

  beforeAll(async () => {
    await listenOnSocket(server, socketPath);
  });
  afterAll(() => {
    server.close();
  });

  it('a refusal comes back as a failed run carrying the reason, not as a crash', async () => {
    const result = await runViaRunner(socketPath, request({ image: 'evil:latest' }));
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/refused \(400\).*SCAN_IMAGE/);
    expect(spawned).toEqual([]);
  });

  it('an invalid document is refused before anything is spawned', async () => {
    const result = await runViaRunner(socketPath, { image: IMAGE } as never);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/invalid request/);
    expect(spawned).toEqual([]);
  });

  it('runInSandbox hands the same profile to the runner when SCAN_RUNNER_SOCKET points at one', async () => {
    const result = await runInSandbox({
      runner: socketPath,
      image: IMAGE,
      snapshotDir: `${ROOT}/snap-xyz`,
      command: ['scan', '--json'],
      budget: { wallClockMs: 5_000, forgeCalls: 0, llmTokens: 0, memoryMb: 256, cpuMillis: 1000 },
      writablePaths: ['/opt/opengrep/.opengrep'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ findings: [] });
    const argv = spawned.at(-1)!;
    expect(argv).toContain('--memory=256m');
    expect(argv).toContain('--tmpfs=/opt/opengrep/.opengrep:rw,noexec,nosuid,size=16m,mode=1777');
    expect(argv).toContain(
      '--volume=/var/lib/containers/storage/volumes/repopulse-scan-scratch/_data/snap-xyz:/scan:ro,noexec',
    );
  });

  it('an unreachable runner is a failed run that names the socket', async () => {
    const result = await runInSandbox({
      runner: path.join(dir, 'nope'),
      image: IMAGE,
      snapshotDir: `${ROOT}/snap-xyz`,
      command: ['scan'],
      budget: { wallClockMs: 1_000 },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/scan-runner at .*nope is not reachable/);
  });

  it('GET /v1/status states the runtime, the image, the database and the unsupported tools', async () => {
    const status = await runnerStatus(socketPath);
    expect(runnerStatusSchema.safeParse(status).success).toBe(true);
    expect(status.runtime).toBe('podman');
    expect(status.runtimeVersion).toBe('5.8.2');
    expect(status.image).toEqual({ name: IMAGE, present: true });
    expect(status.vulnDb.present).toBe(false);
    expect(status.vulnDb.reason).toContain('scan-db-sync');
    expect(status.unsupportedTools.map((t) => t.tool)).toContain('govulncheck');
    expect(status.scanTools.map((t) => t.tool)).toContain('grype');
  });
});

describe('over TCP with a token (the packaged arrangement)', () => {
  const spawned: string[][] = [];
  const spawnFn = ((cmd: string, argv: string[], opts: object) => {
    spawned.push([cmd, ...argv]);
    return realSpawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify({findings:[]}))'],
      opts,
    );
  }) as never;
  const runner = new ScanRunner(config({ spawnFn }));
  const server = createRunnerServer(runner, { token: 'correct-horse' });
  let address = '';

  beforeAll(async () => {
    await listenOnSocket(server, 'http://127.0.0.1:0');
    const bound = server.address();
    if (bound === null || typeof bound === 'string') throw new Error('no tcp address');
    address = `http://127.0.0.1:${bound.port}`;
  });
  afterAll(() => {
    server.close();
  });

  it('refuses a run without the token, and one with the wrong token, before spawning anything', async () => {
    const none = await runViaRunner(address, request(), undefined);
    expect(none.status).toBe('failed');
    expect(none.error).toMatch(/refused \(401\).*SCAN_RUNNER_TOKEN/);
    const wrong = await runViaRunner(address, request(), 'correct-hors');
    expect(wrong.error).toMatch(/refused \(401\)/);
    expect(spawned).toEqual([]);
  });

  it('runs with the right token, and status needs none (the healthcheck has no secret)', async () => {
    const ok = await runViaRunner(address, request(), 'correct-horse');
    expect(ok.status, ok.error).toBe('succeeded');
    expect(spawned.length).toBe(1);
    const status = await runnerStatus(address);
    expect(status.runtime).toBe('podman');
  });

  it('runInSandbox reads the address and token from the environment', async () => {
    const before = { ...process.env };
    process.env.SCAN_RUNNER_URL = address;
    process.env.SCAN_RUNNER_TOKEN = 'correct-horse';
    try {
      const result = await runInSandbox({
        image: IMAGE,
        snapshotDir: `${ROOT}/snap-env`,
        command: ['scan'],
        budget: { wallClockMs: 5_000 },
      });
      expect(result.status).toBe('succeeded');
    } finally {
      delete process.env.SCAN_RUNNER_URL;
      delete process.env.SCAN_RUNNER_TOKEN;
      Object.assign(process.env, before);
    }
  });
});

// ---------------------------------------------------------------------------
// LIVE: a real podman, driven through the runner. Skipped with a reason when
// there is no runtime, exactly like sandbox.test.ts.
const podmanAvailable = (() => {
  try {
    execFileSync('podman', ['info', '--format', '{{.Host.Arch}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const liveImage = (() => {
  if (!podmanAvailable) return undefined;
  const out = execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
    stdio: 'pipe',
  }).toString();
  const images = out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.includes('<none>'));
  return images.find((s) => s.startsWith('localhost/repopulse/scan:')) ?? images[0];
})();

const describeLive = podmanAvailable && liveImage ? describe : describe.skip;

function podman(args: string[]): string {
  return execFileSync('podman', args, { stdio: 'pipe' }).toString().trim();
}

describeLive('scan-runner on a real podman (cleanup: success, timeout, error, restart)', () => {
  const image = liveImage as string;
  const label = `repopulse.scan=test-${process.pid}`;
  const scratch = mkdtempSync(path.join(tmpdir(), 'w17-27-scratch-'));
  const socketDir = mkdtempSync(path.join(tmpdir(), 'w17-27-live-'));
  const socketPath = path.join(socketDir, 's');
  const names: string[] = [];
  const runner = new ScanRunner({
    runtime: 'podman',
    runtimeBinary: 'podman',
    image,
    snapshotRoot: scratch,
    scratch: { mode: 'bind', hostDir: scratch },
    rulesDir: scratch,
    rulesHostDir: scratch,
    maxWallClockMs: 120_000,
    label,
    log: (line) => {
      const m = /(repopulse-scan-[a-z0-9-]+)/.exec(line);
      if (m?.[1] && !names.includes(m[1])) names.push(m[1]);
    },
  });
  const server = createRunnerServer(runner);

  function snapshot(): string {
    const dir = path.join(scratch, `snap-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(path.join(dir, 'source.ts'), 'export const a = 1;\n', { mode: 0o644 });
    return dir;
  }

  const running = (name: string): string =>
    podman(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}} {{.Status}}']);

  beforeAll(async () => {
    await listenOnSocket(server, socketPath);
  });
  afterAll(() => {
    server.close();
    const left = podman(['ps', '-aq', '--filter', `label=${label}`]);
    if (left !== '') podman(['rm', '-f', ...left.split('\n')]);
  });

  it('SUCCESS: reads the snapshot under the profile, and the container is gone afterwards', async () => {
    const result = await runInSandbox({
      runner: socketPath,
      image,
      snapshotDir: snapshot(),
      command: ['sh', '-c', 'cat /scan/source.ts; id -u; cat /proc/net/route'],
      budget: { wallClockMs: 60_000 },
      parseOutput: false,
    });
    expect(result.status).toBe('succeeded');
    expect(result.rawStdout).toContain('export const a = 1;');
    // As the snapshot's owner — this process — not as nobody (see snapshotOwner).
    expect(result.rawStdout).toContain(`\n${process.getuid?.() ?? 65534}\n`);
    // --network=none: nothing but the header line in the routing table.
    const routes = (result.rawStdout ?? '').split('Iface')[1] ?? '';
    expect(
      routes
        .trim()
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.includes('Flags')),
    ).toEqual([]);
    expect(running(names.at(-1)!)).toBe('');
  }, 60_000);

  it('SUCCESS: cannot write the snapshot and does not see the host environment', async () => {
    const result = await runInSandbox({
      runner: socketPath,
      image,
      snapshotDir: snapshot(),
      command: ['sh', '-c', '(echo x > /scan/w 2>/dev/null || echo WRITE_DENIED); env'],
      budget: { wallClockMs: 60_000 },
      parseOutput: false,
    });
    process.env.REPOPULSE_TEST_SECRET = 'must-not-appear';
    expect(result.rawStdout).toContain('WRITE_DENIED');
    expect(result.rawStdout).not.toContain('must-not-appear');
    expect(result.rawStdout).not.toContain('DATABASE_URL');
  }, 60_000);

  it('TIMEOUT: the container is killed at the budget and removed, not left running', async () => {
    const result = await runInSandbox({
      runner: socketPath,
      image,
      snapshotDir: snapshot(),
      command: ['sleep', '600'],
      budget: { wallClockMs: 4_000 },
      parseOutput: false,
    });
    expect(result.status).toBe('timed_out');
    const name = names.at(-1)!;
    expect(running(name)).toBe('');
  }, 60_000);

  it('ERROR: a tool that fails to start is a failed run with its stderr, and no container remains', async () => {
    const result = await runInSandbox({
      runner: socketPath,
      image,
      snapshotDir: snapshot(),
      command: ['/no/such/tool', '--json'],
      budget: { wallClockMs: 60_000 },
      parseOutput: false,
    });
    expect(result.status).toBe('failed');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(running(names.at(-1)!)).toBe('');
  }, 60_000);

  it('RESTART: a runner coming up removes scan containers its predecessor left behind', async () => {
    const orphan = `repopulse-scan-orphan-${process.pid}`;
    podman([
      'run',
      '-d',
      '--name',
      orphan,
      `--label=${label}`,
      '--network=none',
      image,
      'sleep',
      '600',
    ]);
    expect(running(orphan)).toContain('Up');
    const removed = await runner.sweepOrphans();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(running(orphan)).toBe('');
  }, 60_000);

  it('VOLUME MODE: a 0700/0600 snapshot written into a tmpfs volume by the worker uid is read by the scan container', async () => {
    // The packaged arrangement exactly: the worker (uid 100) holds a tmpfs
    // volume and extracts 0700 dirs of 0600 files into it; the runner resolves
    // the volume's mountpoint, binds ONE snapshot dir out of it, ro and
    // noexec, and runs the scan as the owner. The first version of this test
    // wrote 0755/0644 and passed while the packaged stack failed with
    // "Permission denied" — the modes ARE the case.
    const volume = `w17-27-vol-${process.pid}`;
    const writer = `w17-27-writer-${process.pid}`;
    podman([
      'volume',
      'create',
      '--opt',
      'type=tmpfs',
      '--opt',
      'device=tmpfs',
      '--opt',
      'o=size=32m,mode=1777,noexec',
      volume,
    ]);
    try {
      podman([
        'run',
        '-d',
        '--name',
        writer,
        `--label=${label}`,
        '--user',
        '100:101',
        '-v',
        `${volume}:/var/tmp/repopulse-scan`,
        image,
        'sh',
        '-c',
        'mkdir -m 700 /var/tmp/repopulse-scan/snap-vol && echo VOLUME_OK > /var/tmp/repopulse-scan/snap-vol/a.txt && chmod 600 /var/tmp/repopulse-scan/snap-vol/a.txt && sleep 600',
      ]);
      const volRunner = new ScanRunner({
        // This process is outside the VM and cannot stat the volume; the
        // packaged runner stats it through its own read-only mount (unit test
        // above, and the packaged smoke in docs/work/product-completion/evidence).
        statFn: () => '100:101',
        runtime: 'podman',
        runtimeBinary: 'podman',
        image,
        snapshotRoot: '/var/tmp/repopulse-scan',
        scratch: { mode: 'volume', volume },
        rulesDir: scratch,
        rulesHostDir: scratch,
        maxWallClockMs: 60_000,
        label,
        log: () => {},
      });
      // Poll: the writer needs a moment to create the file.
      let result;
      for (let i = 0; i < 20; i++) {
        result = await volRunner.run({
          image,
          snapshotDir: '/var/tmp/repopulse-scan/snap-vol',
          command: ['sh', '-c', 'id -u && cat /scan/a.txt && mount | grep " /scan "'],
          budget: { wallClockMs: 30_000 },
        });
        if (result.status === 'succeeded') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(result?.status, result?.stderr).toBe('succeeded');
      expect(result?.stdout).toContain('100\nVOLUME_OK');
      expect(result?.stdout).toMatch(/\bro\b/);
      expect(result?.stdout).toContain('noexec');
    } finally {
      podman(['rm', '-f', writer]);
      podman(['volume', 'rm', '-f', volume]);
    }
  }, 120_000);
});

// Docker has no live coverage on this machine and says so, instead of a
// podman result standing in for it (acceptance 4: "each tested on the runtime
// it targets"). When a docker daemon is present the same live suite should be
// pointed at it; until then the docker argv is covered by sandbox.test.ts only.
const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

(dockerAvailable ? describe : describe.skip)('scan-runner on a real docker', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'w17-27-docker-'));
  const runner = new ScanRunner({
    runtime: 'docker',
    runtimeBinary: 'docker',
    image: 'alpine:3.20',
    snapshotRoot: scratch,
    scratch: { mode: 'bind', hostDir: scratch },
    rulesDir: scratch,
    rulesHostDir: scratch,
    maxWallClockMs: 60_000,
    label: `repopulse.scan=test-${process.pid}`,
    log: () => {},
  });

  it('docker run accepts the docker builder argv and the snapshot is read-only', async () => {
    const dir = path.join(scratch, 'snap-docker');
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(path.join(dir, 'a.txt'), 'DOCKER_OK\n', { mode: 0o644 });
    const result = await runner.run({
      image: 'alpine:3.20',
      snapshotDir: dir,
      command: ['sh', '-c', 'cat /scan/a.txt; (echo x > /scan/w 2>/dev/null || echo WRITE_DENIED)'],
      budget: { wallClockMs: 30_000 },
    });
    expect(result.status).toBe('succeeded');
    expect(result.stdout).toContain('DOCKER_OK');
    expect(result.stdout).toContain('WRITE_DENIED');
  }, 60_000);
});
