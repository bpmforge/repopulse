import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildSandboxArgs,
  SCAN_CONTAINER_LABEL,
  scanContainerName,
  type SandboxProfileArgs,
  type SandboxRuntime,
} from './profile.js';
import {
  DEFAULT_RUNNER_SOCKET,
  parseRunnerAddress,
  RUNNER_AUTH_HEADER,
  RUNNER_RUN_PATH,
  RUNNER_STATUS_PATH,
  runnerRequestSchema,
  SNAPSHOT_NAME_PATTERN,
  type RunnerRequest,
  type RunnerResponse,
  type RunnerStatus,
} from './runner-protocol.js';
import { spawnSandbox } from './spawn.js';
import { readVulnDbStatus, SCAN_TOOLS, UNSUPPORTED_TOOLS } from './tooling.js';

// The scan-runner (W17-27).
//
// One process, one job: turn a validated request from the worker into a
// container run under the §2.2 profile, on the runtime whose socket it holds,
// and report what happened. It is the only service in the packaged stack that
// can start a container, and it is built so that holding it is worth as little
// as possible:
//   - it has no database URL, no Redis, no forge credential and no customer
//     source of its own — the snapshot is on a volume the worker fills;
//   - the image is ITS configuration, not the request's; a request naming a
//     different image is refused;
//   - every host path that reaches the runtime is derived here from the
//     runner's own configuration plus a validated single path segment, never
//     copied from the request;
//   - the argv is the same buildSandboxArgs the dev checkout spawns directly,
//     so the profile is one thing whichever way it is reached.
//
// What it does NOT do is bound what a compromised runner could ask the socket
// for. That is the honest limit of this design and the reason the runner is a
// separate, minimal container rather than the worker itself: the process that
// parses attacker-influenced tool output and holds credentials is not the one
// with the socket.

const execFileP = promisify(execFile);

export interface RunnerConfig {
  runtime: SandboxRuntime;
  /** Binary to spawn: podman, podman-remote, docker, or a path to one. */
  runtimeBinary: string;
  /** Runtime socket the binary should address; unset means its default. */
  containerSocket?: string;
  /** The only image a request may name. */
  image: string;
  /** The worker's view of the snapshot scratch root. */
  snapshotRoot: string;
  /** How the runtime reaches the same scratch: a named volume, or a host directory. */
  scratch: { mode: 'volume'; volume: string } | { mode: 'bind'; hostDir: string };
  /** The worker's view of the synced rules root. */
  rulesDir: string;
  /** The same root as the runtime's daemon sees it. */
  rulesHostDir: string;
  /** Wall-clock ceiling a request may ask for. */
  maxWallClockMs: number;
  /**
   * Shared secret required on /v1/run. Optional for a unix socket, whose
   * directory is the access control; REQUIRED for a TCP listener, because a
   * port on a compose network is reachable by every container on it.
   */
  token?: string;
  /** Container label; defaults to SCAN_CONTAINER_LABEL. Tests set their own. */
  label?: string;
  /** Test seam. Prod always spawns. */
  spawnFn?: typeof spawn;
  /** Test seam for the runtime's own queries (version, volume inspect, ps). */
  queryFn?: (args: string[]) => Promise<string>;
  /** Test seam for the snapshot-owner lookup; prod stats the directory. */
  statFn?: (dir: string) => string | null;
  log?: (line: string) => void;
}

/** Reads the runner's configuration from the environment; throws on nonsense. */
export function runnerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const runtime: SandboxRuntime = env.SCAN_RUNTIME === 'docker' ? 'docker' : 'podman';
  const containerSocket =
    env.CONTAINER_SOCKET && env.CONTAINER_SOCKET !== '' ? env.CONTAINER_SOCKET : undefined;
  const runtimeBinary =
    env.SCAN_RUNTIME_BIN ??
    (runtime === 'docker' ? 'docker' : containerSocket !== undefined ? 'podman-remote' : 'podman');
  const snapshotRoot = env.SNAPSHOT_ROOT ?? '/var/tmp/repopulse-scan';
  const rulesDir = env.SCAN_RULES_DIR ?? '/var/lib/repopulse/scan-rules';

  let scratch: RunnerConfig['scratch'];
  if (env.SCAN_SCRATCH_VOLUME && env.SCAN_SCRATCH_VOLUME !== '') {
    scratch = { mode: 'volume', volume: env.SCAN_SCRATCH_VOLUME };
  } else if (env.SCAN_SCRATCH_HOST_DIR && env.SCAN_SCRATCH_HOST_DIR !== '') {
    scratch = { mode: 'bind', hostDir: env.SCAN_SCRATCH_HOST_DIR };
  } else {
    throw new Error(
      'scan-runner: set SCAN_SCRATCH_VOLUME (the named volume the worker extracts snapshots into) ' +
        'or SCAN_SCRATCH_HOST_DIR (the host directory, when worker and runner share one)',
    );
  }

  return {
    runtime,
    runtimeBinary,
    ...(containerSocket !== undefined ? { containerSocket } : {}),
    image: env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev',
    snapshotRoot,
    scratch,
    rulesDir,
    rulesHostDir: env.SCAN_RULES_HOST_DIR ?? rulesDir,
    maxWallClockMs: Number(env.SCAN_MAX_WALL_CLOCK_MS ?? 60 * 60 * 1000),
    ...(env.SCAN_RUNNER_TOKEN && env.SCAN_RUNNER_TOKEN !== ''
      ? { token: env.SCAN_RUNNER_TOKEN }
      : {}),
  };
}

/** Where to listen: SCAN_RUNNER_LISTEN (path or http://host:port), else the default socket. */
export function runnerListenAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCAN_RUNNER_LISTEN && env.SCAN_RUNNER_LISTEN !== ''
    ? env.SCAN_RUNNER_LISTEN
    : (env.SCAN_RUNNER_SOCKET ?? DEFAULT_RUNNER_SOCKET);
}

/** Flags that precede every subcommand: how the binary finds its daemon. */
export function runtimeGlobalArgs(
  config: Pick<RunnerConfig, 'runtime' | 'containerSocket'>,
): string[] {
  if (config.containerSocket === undefined) return [];
  return config.runtime === 'docker'
    ? ['-H', `unix://${config.containerSocket}`]
    : ['--url', `unix://${config.containerSocket}`];
}

/**
 * Environment for the runtime CLIENT process. PATH so the binary resolves,
 * HOME and XDG_RUNTIME_DIR because podman-remote reads its connection config
 * from there when a --url is not given. Nothing secret lives in this process
 * to begin with, and the container still receives none of it: no --env is
 * ever passed (profile.ts).
 */
export function runnerProcessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  if (env.HOME) out.HOME = env.HOME;
  if (env.XDG_RUNTIME_DIR) out.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;
  return out;
}

/** Container paths a request may not mount over: the image's own tree and the sandbox's. */
const CONTAINER_PATH_DENY = [
  '/',
  '/scan',
  '/tmp',
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/opt',
  '/root',
  '/run',
  '/var',
  '/home',
];

function underAny(p: string, roots: readonly string[]): boolean {
  return roots.some((root) => p === root || (root !== '/' && p.startsWith(`${root}/`)));
}

/** A relative path with no `..`, `.` or empty segments — the only shape that translates safely. */
function cleanRelative(root: string, candidate: string): string | null {
  const normalized = path.posix.normalize(candidate);
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;
  if (normalized === root) return '';
  if (!normalized.startsWith(rootWithSlash)) return null;
  const rel = normalized.slice(rootWithSlash.length);
  if (rel === '' || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'))
    return null;
  return rel;
}

/**
 * Who the scan container runs as when the request does not say (W17-27).
 *
 * The worker extracts a snapshot as ITS unprivileged uid, mode 0700 with 0600
 * files — deliberately, so nothing else on a shared temp dir can read customer
 * source. The scan container is a sibling started by the daemon, and `nobody`
 * in it is a different uid from the worker's: measured on the packaged stack
 * as "ls: can't open '/scan': Permission denied" for every tool, while the
 * same container as the owner uid read the file. So the runner stats the
 * snapshot through its own read-only mount of the scratch and runs the scan
 * as the uid:gid that owns it. It is still unprivileged, still on a read-only
 * bind of one directory with no network and no capabilities — ownership buys
 * it exactly the read the scan exists to do. Root-owned falls through to the
 * profile default (65534), which the request check below would refuse anyway.
 */
function snapshotOwner(dir: string): string | null {
  try {
    const st = statSync(dir);
    return st.uid === 0 ? null : `${st.uid}:${st.gid}`;
  } catch {
    return null;
  }
}

export class RunnerRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerRefusal';
  }
}

export class ScanRunner {
  private readonly config: RunnerConfig;
  private scratchHostRoot: string | null;
  private readonly log: (line: string) => void;
  readonly label: string;
  sweptOnBoot = 0;

  constructor(config: RunnerConfig) {
    this.config = config;
    this.scratchHostRoot = config.scratch.mode === 'bind' ? config.scratch.hostDir : null;
    this.label = config.label ?? SCAN_CONTAINER_LABEL;
    this.log = config.log ?? ((line) => process.stdout.write(`[scan-runner] ${line}\n`));
  }

  /** Runs a runtime QUERY (never `run`) and returns its trimmed stdout. */
  private async query(args: string[]): Promise<string> {
    if (this.config.queryFn) return this.config.queryFn(args);
    const { stdout } = await execFileP(
      this.config.runtimeBinary,
      [...runtimeGlobalArgs(this.config), ...args],
      { env: runnerProcessEnv(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.toString().trim();
  }

  /**
   * Where the scratch lives for the runtime's daemon. For a named volume that
   * is the volume's mountpoint — a tmpfs volume stays mounted there for as
   * long as any container (the worker) holds it, which is why the worker
   * mounts it for its whole life and never only for a scan.
   */
  async scratchHostPath(): Promise<string> {
    if (this.scratchHostRoot !== null) return this.scratchHostRoot;
    const scratch = this.config.scratch;
    if (scratch.mode !== 'volume') throw new Error('unreachable');
    const out = await this.query([
      'volume',
      'inspect',
      '--format',
      '{{.Mountpoint}}',
      scratch.volume,
    ]);
    if (out === '' || !out.startsWith('/')) {
      throw new RunnerRefusal(
        `scratch volume ${scratch.volume} has no mountpoint — is the worker up?`,
      );
    }
    this.scratchHostRoot = out;
    return out;
  }

  /** Validates a request against the configuration and translates its paths. */
  async toProfile(req: RunnerRequest): Promise<SandboxProfileArgs> {
    const c = this.config;
    if (req.image !== c.image) {
      throw new RunnerRefusal(
        `image ${JSON.stringify(req.image)} is not this runner's SCAN_IMAGE (${c.image})`,
      );
    }
    if (req.budget.wallClockMs > c.maxWallClockMs) {
      throw new RunnerRefusal(
        `wallClockMs ${req.budget.wallClockMs} exceeds the runner's cap of ${c.maxWallClockMs}`,
      );
    }
    if (req.user !== undefined && req.user.startsWith('0:')) {
      throw new RunnerRefusal('a scan container never runs as uid 0');
    }

    const snapName = cleanRelative(c.snapshotRoot, req.snapshotDir);
    if (snapName === null || snapName === '' || !SNAPSHOT_NAME_PATTERN.test(snapName)) {
      throw new RunnerRefusal(
        `snapshotDir must be one snap-* directory directly under ${c.snapshotRoot}; got ${JSON.stringify(req.snapshotDir)}`,
      );
    }
    const snapshotDir = path.posix.join(await this.scratchHostPath(), snapName);
    // The runner's own view of the same directory (compose mounts the scratch
    // at the worker's path, read-only), for the ownership check above.
    const user =
      req.user ??
      (this.config.statFn ?? snapshotOwner)(path.posix.join(c.snapshotRoot, snapName)) ??
      undefined;

    const extraMounts: { hostPath: string; containerPath: string }[] = [];
    for (const m of req.extraMounts ?? []) {
      const rel = cleanRelative(c.rulesDir, m.hostPath);
      if (rel === null) {
        throw new RunnerRefusal(
          `extra mount ${JSON.stringify(m.hostPath)} is outside the rules dir ${c.rulesDir}`,
        );
      }
      const containerPath = path.posix.normalize(m.containerPath);
      if (!containerPath.startsWith('/') || underAny(containerPath, CONTAINER_PATH_DENY)) {
        throw new RunnerRefusal(`extra mount may not target ${JSON.stringify(m.containerPath)}`);
      }
      extraMounts.push({
        hostPath: rel === '' ? c.rulesHostDir : path.posix.join(c.rulesHostDir, rel),
        containerPath,
      });
    }

    const writablePaths: string[] = [];
    for (const p of req.writablePaths ?? []) {
      const normalized = path.posix.normalize(p);
      if (
        !normalized.startsWith('/') ||
        underAny(normalized, ['/', '/scan', '/proc', '/sys', '/dev'])
      ) {
        throw new RunnerRefusal(`writable path may not be ${JSON.stringify(p)}`);
      }
      writablePaths.push(normalized);
    }

    return {
      image: c.image,
      snapshotDir,
      command: req.command,
      budget: {
        wallClockMs: req.budget.wallClockMs,
        ...(req.budget.memoryMb !== undefined ? { memoryMb: req.budget.memoryMb } : {}),
        ...(req.budget.cpuMillis !== undefined ? { cpuMillis: req.budget.cpuMillis } : {}),
      },
      ...(user !== undefined ? { user } : {}),
      ...(req.pidsLimit !== undefined ? { pidsLimit: req.pidsLimit } : {}),
      ...(extraMounts.length > 0 ? { extraMounts } : {}),
      ...(writablePaths.length > 0 ? { writablePaths } : {}),
      containerName: scanContainerName(),
      label: this.label,
    };
  }

  /** Runs one validated request. Refusals throw RunnerRefusal; everything else is a result. */
  async run(req: RunnerRequest): Promise<RunnerResponse> {
    const profile = await this.toProfile(req);
    const argv = buildSandboxArgs(profile, this.config.runtime);
    const startedAt = Date.now();
    this.log(
      `run ${profile.containerName} ${JSON.stringify(req.command[0])} wall=${req.budget.wallClockMs}ms`,
    );
    const result = await spawnSandbox({
      runtimeBinary: this.config.runtimeBinary,
      globalArgs: runtimeGlobalArgs(this.config),
      argv,
      containerName: profile.containerName!,
      wallClockMs: req.budget.wallClockMs,
      ...(req.maxStdoutBytes !== undefined ? { maxStdoutBytes: req.maxStdoutBytes } : {}),
      env: runnerProcessEnv(),
      ...(this.config.spawnFn ? { spawnFn: this.config.spawnFn } : {}),
    });
    this.log(
      `done ${profile.containerName} ${result.status} exit=${String(result.exitCode)} in ${Date.now() - startedAt}ms`,
    );
    return result;
  }

  /**
   * Removes every scan container a previous runner left behind (acceptance 2:
   * cleanup after a restart). A runner killed mid-scan cannot run its own
   * timeout handler; the label lets its successor finish the job before it
   * accepts new work.
   */
  async sweepOrphans(): Promise<number> {
    let ids: string[] = [];
    try {
      const out = await this.query([
        'ps',
        '-a',
        '--filter',
        `label=${this.label}`,
        '--format',
        '{{.ID}}',
      ]);
      ids = out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    } catch (err) {
      this.log(`orphan sweep could not list containers: ${(err as Error).message}`);
      return 0;
    }
    if (ids.length === 0) return 0;
    try {
      await this.query(['rm', '--force', ...ids]);
      this.log(`orphan sweep removed ${ids.length} scan container(s)`);
      return ids.length;
    } catch (err) {
      this.log(
        `orphan sweep could not remove ${ids.length} container(s): ${(err as Error).message}`,
      );
      return 0;
    }
  }

  async status(): Promise<RunnerStatus> {
    const c = this.config;
    let runtimeVersion: string | null = null;
    try {
      runtimeVersion = await this.query(['version', '--format', '{{.Server.Version}}']);
    } catch {
      runtimeVersion = null;
    }
    let present: boolean | null = null;
    try {
      // `image exists` is podman-only; `image inspect` answers the same
      // question on both and its exit code is the answer.
      await this.query(['image', 'inspect', '--format', '{{.Id}}', c.image]);
      present = true;
    } catch (err) {
      present = /no such|not known|not found|does not exist/i.test((err as Error).message)
        ? false
        : null;
    }
    let hostPath: string | null = null;
    try {
      hostPath = await this.scratchHostPath();
    } catch {
      hostPath = null;
    }
    return {
      runtime: c.runtime,
      runtimeBinary: c.runtimeBinary,
      runtimeVersion,
      image: { name: c.image, present },
      scratch: {
        mode: c.scratch.mode,
        source: c.scratch.mode === 'volume' ? c.scratch.volume : c.scratch.hostDir,
        hostPath,
      },
      // Read through the runner's OWN mount of the rules dir, so the answer
      // describes the same files the scan container will be handed.
      vulnDb: readVulnDbStatus(path.join(c.rulesDir, 'vuln-db')),
      scanTools: SCAN_TOOLS.map((t) => ({ tool: t.tool, usedBy: [...t.usedBy] })),
      unsupportedTools: UNSUPPORTED_TOOLS.map((t) => ({ ...t })),
      sweptOnBoot: this.sweptOnBoot,
    };
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > limit) {
        reject(new RunnerRefusal(`request body over ${limit} bytes`));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Constant-time-ish equality for the bearer token; length leaks nothing useful here. */
function tokenMatches(header: string | undefined, expected: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** The HTTP face of a ScanRunner. Exported so a test can drive it on a temp socket. */
export function createRunnerServer(runner: ScanRunner, opts: { token?: string } = {}): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === RUNNER_STATUS_PATH) {
        // Unauthenticated on purpose: it holds no secret, and the container
        // healthcheck needs it without a token in the Dockerfile.
        send(res, 200, await runner.status());
        return;
      }
      if (req.method === 'POST' && req.url === RUNNER_RUN_PATH) {
        if (opts.token !== undefined) {
          const header = req.headers[RUNNER_AUTH_HEADER];
          if (!tokenMatches(typeof header === 'string' ? header : undefined, opts.token)) {
            send(res, 401, { error: 'scan-runner: missing or wrong SCAN_RUNNER_TOKEN' });
            return;
          }
        }
        const body = await readBody(req, 1024 * 1024);
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          send(res, 400, { error: 'body is not JSON' });
          return;
        }
        const parsed = runnerRequestSchema.safeParse(json);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          send(res, 400, {
            error: `invalid request: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
          });
          return;
        }
        send(res, 200, await runner.run(parsed.data));
        return;
      }
      send(res, 404, { error: `no route ${req.method ?? ''} ${req.url ?? ''}` });
    } catch (err) {
      if (err instanceof RunnerRefusal) {
        send(res, 400, { error: err.message });
        return;
      }
      send(res, 500, { error: (err as Error).message });
    }
  });
}

/** Listens on a unix socket, replacing a stale file from a previous life. */
export async function listenOnSocket(server: Server, address: string, mode = 0o666): Promise<void> {
  const target = parseRunnerAddress(address);
  if (target.kind === 'tcp') {
    // The packaged arrangement: a port on the internal scan network, which
    // is why main() insists on a token before it will listen this way.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target.port, target.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return;
  }
  mkdirSync(path.dirname(target.path), { recursive: true });
  if (existsSync(target.path)) unlinkSync(target.path);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(target.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // The worker connects as a different uid across a shared volume, and only
  // the two of them mount that volume — so world-writable on the SOCKET is a
  // statement about a directory nothing else can see.
  chmodSync(target.path, mode);
}

async function main(): Promise<void> {
  const config = runnerConfigFromEnv();
  const runner = new ScanRunner(config);
  const address = runnerListenAddress();
  if (parseRunnerAddress(address).kind === 'tcp' && config.token === undefined) {
    // A port with no token is a scan endpoint for every container on the
    // network. Refuse to be that rather than warn about it.
    throw new Error('SCAN_RUNNER_LISTEN is a TCP address, so SCAN_RUNNER_TOKEN is required');
  }

  runner.sweptOnBoot = await runner.sweepOrphans();
  const server = createRunnerServer(
    runner,
    config.token !== undefined ? { token: config.token } : {},
  );
  await listenOnSocket(server, address);
  const status = await runner.status();
  process.stdout.write(
    `[scan-runner] listening on ${address}${config.token ? ' (token required)' : ''}; runtime ${status.runtime} ${status.runtimeVersion ?? '(version unknown)'} via ${config.runtimeBinary}; ` +
      `image ${status.image.name} ${status.image.present === true ? 'present' : status.image.present === false ? 'MISSING' : 'unverified'}; ` +
      `scratch ${status.scratch.mode} ${status.scratch.source} -> ${status.scratch.hostPath ?? '(unresolved)'}; ` +
      `vuln-db ${status.vulnDb.present ? `built ${status.vulnDb.builtAt ?? '?'} (${String(status.vulnDb.ageDays)}d${status.vulnDb.stale ? ', STALE' : ''})` : `absent: ${status.vulnDb.reason ?? ''}`}; ` +
      `swept ${status.sweptOnBoot} orphan(s)\n`,
  );

  const shutdown = (): void => {
    server.close(() => {
      const target = parseRunnerAddress(address);
      if (target.kind === 'unix') {
        try {
          unlinkSync(target.path);
        } catch {
          // already gone
        }
      }
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`[scan-runner] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
