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

export interface SandboxProfileArgs {
  image: string;
  /** Host directory holding the snapshot - mounted read-only at /scan. */
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
}

export const SCAN_MOUNT_PATH = '/scan';

export function buildSandboxArgs(args: SandboxProfileArgs): string[] {
  const budget = args.budget;
  const argv = [
    'run',
    '--rm',
    // No network at all. A scan tool has everything it needs on the mount, and
    // the alternative - an allowlisted proxy - is a much larger thing to get
    // right for no scanning benefit. Tools that need a vulnerability database
    // get it baked into their image (W8-06).
    '--network=none',
    '--read-only',
    `--user=${args.user ?? '65534:65534'}`,
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    `--pids-limit=${args.pidsLimit ?? 256}`,
    // ro AND noexec: a scanner reads the source, it never runs it, and a
    // repository is full of executable files someone else wrote.
    `--volume=${args.snapshotDir}:${SCAN_MOUNT_PATH}:ro,noexec`,
    `--workdir=${SCAN_MOUNT_PATH}`,
  ];

  for (const mount of args.extraMounts ?? []) {
    argv.push(`--volume=${mount.hostPath}:${mount.containerPath}:ro,noexec`);
  }

  if (budget.memoryMb !== undefined) argv.push(`--memory=${budget.memoryMb}m`);
  if (budget.cpuMillis !== undefined) argv.push(`--cpus=${(budget.cpuMillis / 1000).toFixed(2)}`);
  // A scan tool that writes anything writes it here, in RAM, and it dies with
  // the container. --read-only without a tmpfs breaks tools that write temp
  // files, which is most of them.
  // mode=1777, because a tmpfs mounts root-owned 0755 by default and the
  // container runs unprivileged — an unwritable scratch directory presents as a
  // permission error deep inside whatever tool is running and reads as a tool
  // bug rather than a mount option. (podman rejects uid=/gid= mount options
  // here, verified against podman on this machine; sticky 1777 is the portable
  // form and the container has exactly one user in it.)
  argv.push('--tmpfs=/tmp:rw,noexec,nosuid,size=256m,mode=1777');
  for (const path of args.writablePaths ?? []) {
    // noexec on these too: a tool may need to WRITE a file, never to run one
    // it just wrote. That is the difference between a cache and a foothold.
    argv.push(`--tmpfs=${path}:rw,noexec,nosuid,size=16m,mode=1777`);
  }
  // Podman's own kill switch, in seconds, as a backstop to the runner's timer:
  // if this process dies the container should still not outlive its budget.
  argv.push(`--timeout=${Math.max(1, Math.ceil(budget.wallClockMs / 1000))}`);

  argv.push(args.image, ...args.command);
  return argv;
}

/** Env for the container process: empty, by construction. */
export function sandboxEnv(): Record<string, string> {
  return {};
}
