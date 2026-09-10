import path from 'node:path';
import type { ScanBudget } from '../src/framework/types.js';

// Sandbox profile (W8-03, SECURITY_SUITE.md 2.2, NFR-14).
//
// Scan tools are third-party binaries pointed at a customer's source. The
// profile is the whole of the trust boundary, so it is built as DATA - an argv
// array - rather than as a shell string, and every flag on it is asserted by a
// test. A flag that exists only in a runbook is a flag that is missing the day
// someone copies the command.
//
// The credential rule is the one worth restating: the container gets NO
// environment from this process. Not a filtered copy of it, an empty one. A
// denylist of secret-looking names is a guess about what the next wave will add
// to the environment; an empty env is not.
//
// TWO RUNTIMES, TWO BUILDERS (W17-27). The first version of this file built one
// argv and claimed "docker works with the same argv". It did not: `--timeout`
// is Podman-only and `docker run` rejects it, and docker's `-v` does not accept
// `noexec`. So each runtime now has its own builder over one shared core, and
// each builder is asserted against the flag set its runtime documents. The
// core is what the boundary IS; the two builders are how each runtime spells it.

export type SandboxRuntime = 'podman' | 'docker';

export interface SandboxProfileArgs {
  image: string;
  /**
   * Directory holding the snapshot - mounted read-only at /scan.
   *
   * A HOST path as far as the runtime is concerned: whatever process spawns
   * the runtime must hand it a path the runtime's daemon can bind. In the
   * packaged stack that translation is the scan-runner's job (runner-server.ts).
   */
  snapshotDir: string;
  /** Command + args to run inside the container. */
  command: readonly string[];
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  /** Unprivileged UID:GID. Default is nobody. */
  user?: string;
  pidsLimit?: number;
  /** Extra read-only mount for a rulepack, etc. */
  extraMounts?: readonly { hostPath: string; containerPath: string }[];
  /**
   * Paths the tool must be able to write, each mounted as its own small tmpfs
   * (W8-12).
   *
   * Every real scan tool needs SOMEWHERE to write — a log, a cache, a temp
   * file. The two alternatives are worse: dropping --read-only hands the whole
   * filesystem over, and making the tool's install directory writable lets one
   * scan mutate the binary the next scan runs. A named, noexec, size-capped
   * tmpfs over exactly the paths a tool declares keeps the blast radius the
   * size of the requirement.
   */
  writablePaths?: readonly string[];
  /**
   * Container name (W17-27). Set so a timed-out container can be removed BY
   * NAME: killing the attached client does not stop the container under
   * either runtime, and the podman `--timeout` backstop has no docker
   * equivalent. The runner generates one per run when the caller does not.
   */
  containerName?: string;
  /**
   * `key=value` label on the container. Defaults to SCAN_CONTAINER_LABEL; a
   * runner under test sets its own so its orphan sweep cannot touch a scan
   * another test is running beside it.
   */
  label?: string;
}

export const SCAN_MOUNT_PATH = '/scan';

/**
 * Label every scan container carries, so a restarted runner can find and
 * remove the ones a killed predecessor left behind (acceptance: cleanup after
 * worker restart). A label rather than a name prefix, because both runtimes
 * filter `ps` by label and neither does prefix matching.
 */
export const SCAN_CONTAINER_LABEL = 'repopulse.scan=1';

let nameCounter = 0;

/** A unique, runtime-legal container name for one scan run. */
export function scanContainerName(now: () => number = Date.now): string {
  nameCounter = (nameCounter + 1) % 1_000_000;
  return `repopulse-scan-${now().toString(36)}-${process.pid}-${nameCounter.toString(36)}`;
}

/**
 * Which builder a runtime binary needs, from its name: `docker`, a path to
 * docker, or a `docker-*` wrapper get the docker argv; everything else (podman,
 * podman-remote, or a test stub) gets podman's.
 */
export function runtimeFlavour(runtimeBinary: string): SandboxRuntime {
  const base = path.basename(runtimeBinary).toLowerCase();
  return base === 'docker' || base.startsWith('docker-') || base.startsWith('docker.')
    ? 'docker'
    : 'podman';
}

/** The flags both runtimes share, in the order both accept them. */
function coreArgs(args: SandboxProfileArgs): string[] {
  const argv = [
    'run',
    '--rm',
    ...(args.containerName ? [`--name=${args.containerName}`] : []),
    `--label=${args.label ?? SCAN_CONTAINER_LABEL}`,
    // No network at all. A scan tool has everything it needs on the mount, and
    // the alternative - an allowlisted proxy - is a much larger thing to get
    // right for no scanning benefit. Tools that need a vulnerability database
    // get it as a read-only mount (W8-06, deploy/scan-db-sync.sh).
    '--network=none',
    '--read-only',
    `--user=${args.user ?? '65534:65534'}`,
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    `--pids-limit=${args.pidsLimit ?? 256}`,
  ];
  return argv;
}

function limitArgs(budget: SandboxProfileArgs['budget']): string[] {
  const argv: string[] = [];
  if (budget.memoryMb !== undefined) argv.push(`--memory=${budget.memoryMb}m`);
  if (budget.cpuMillis !== undefined) argv.push(`--cpus=${(budget.cpuMillis / 1000).toFixed(2)}`);
  return argv;
}

function tmpfsArgs(args: SandboxProfileArgs): string[] {
  // A scan tool that writes anything writes it here, in RAM, and it dies with
  // the container. --read-only without a tmpfs breaks tools that write temp
  // files, which is most of them.
  // mode=1777, because a tmpfs mounts root-owned 0755 by default and the
  // container runs unprivileged — an unwritable scratch directory presents as a
  // permission error deep inside whatever tool is running and reads as a tool
  // bug rather than a mount option. (podman rejects uid=/gid= mount options
  // here, verified against podman on this machine; sticky 1777 is the portable
  // form and the container has exactly one user in it.)
  const argv = ['--tmpfs=/tmp:rw,noexec,nosuid,size=256m,mode=1777'];
  for (const p of args.writablePaths ?? []) {
    // noexec on these too: a tool may need to WRITE a file, never to run one
    // it just wrote. That is the difference between a cache and a foothold.
    argv.push(`--tmpfs=${p}:rw,noexec,nosuid,size=16m,mode=1777`);
  }
  return argv;
}

/**
 * Podman's spelling of the profile.
 *
 * `-v ...:ro,noexec` is accepted, so the snapshot and every extra mount are
 * both read-only AND noexec: a scanner reads the source, it never runs it, and
 * a repository is full of executable files someone else wrote. `--timeout` is
 * podman's own kill switch, in seconds, as a backstop to the runner's timer —
 * if the spawning process dies the container still does not outlive its
 * budget. It is set BACKSTOP_MARGIN_S above the runner's own timer, never
 * equal to it: at the same nominal budget the two raced, and whichever fired
 * first named the outcome. When podman won, `podman run` exited non-zero a
 * few ms before the runner's timer and a scan that ran out of time was
 * recorded as `failed` (seen under full-suite load on podman machine). The
 * runner's timer is the one that classifies; podman's only has to exist.
 */
export const BACKSTOP_MARGIN_S = 5;
export function buildPodmanArgs(args: SandboxProfileArgs): string[] {
  const argv = coreArgs(args);
  argv.push(
    `--volume=${args.snapshotDir}:${SCAN_MOUNT_PATH}:ro,noexec`,
    `--workdir=${SCAN_MOUNT_PATH}`,
  );
  for (const mount of args.extraMounts ?? []) {
    argv.push(`--volume=${mount.hostPath}:${mount.containerPath}:ro,noexec`);
  }
  argv.push(...limitArgs(args.budget), ...tmpfsArgs(args));
  argv.push(`--timeout=${Math.ceil(args.budget.wallClockMs / 1000) + BACKSTOP_MARGIN_S}`);
  argv.push(args.image, ...args.command);
  return argv;
}

/**
 * Docker's spelling of the profile.
 *
 * Two documented differences from podman, neither of them a relaxation chosen
 * for convenience:
 *   - `docker run` has no `--timeout`. The wall-clock kill is the runner's
 *     timer plus an explicit `rm -f` by name (run.ts / runner-server.ts), which
 *     is why `containerName` exists.
 *   - docker's bind mounts accept `readonly` but not `noexec`. The snapshot is
 *     still non-executable in the packaged stack because the scratch VOLUME it
 *     lives on is created noexec (deploy/compose.yaml); a rulepack or database
 *     mount is data a tool reads, never a path it executes from.
 * `--mount` rather than `-v`, so a snapshot path containing a colon cannot be
 * mis-split into a mode.
 */
export function buildDockerArgs(args: SandboxProfileArgs): string[] {
  const argv = coreArgs(args);
  argv.push(
    `--mount=type=bind,source=${args.snapshotDir},target=${SCAN_MOUNT_PATH},readonly`,
    `--workdir=${SCAN_MOUNT_PATH}`,
  );
  for (const mount of args.extraMounts ?? []) {
    argv.push(`--mount=type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
  }
  argv.push(...limitArgs(args.budget), ...tmpfsArgs(args));
  argv.push(args.image, ...args.command);
  return argv;
}

/** The profile for a runtime, by flavour. Podman when unspecified, as before. */
export function buildSandboxArgs(
  args: SandboxProfileArgs,
  runtime: SandboxRuntime = 'podman',
): string[] {
  return runtime === 'docker' ? buildDockerArgs(args) : buildPodmanArgs(args);
}

/**
 * Environment for the CONTAINER RUNTIME process — not for the container.
 *
 * These are two different things and conflating them broke the first version
 * of this: spawning podman with a completely empty environment means podman
 * itself cannot be found (`spawn podman ENOENT`), because PATH is how a name
 * becomes a binary.
 *
 * What matters for the boundary is what the CONTAINER sees, and podman does
 * not copy the host environment into it — only the image's own env plus its
 * defaults. Verified live: a host variable set beside the run does not appear
 * in `env` inside the container (see sandbox.test.ts). `--unsetenv-all` would
 * additionally strip the image's own env, which would break tools that need
 * HOME or PATH set by the image.
 */
export function runtimeEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin' };
}

/** @deprecated Use runtimeEnv — kept so the old name is not silently reused. */
export const sandboxEnv = runtimeEnv;
