import { z } from 'zod';

// The wire contract between a worker and the scan-runner (W17-27).
//
// WHY A RUNNER EXISTS. The packaged worker is node:alpine, runs as an
// unprivileged user with no-new-privileges, cap_drop ALL and no container
// socket — and that is correct: it holds forge credentials and database access,
// so it is the last process that should be able to start containers. But a
// scan IS a container. The scan-runner is the one service that holds the
// container socket, and it holds nothing else: no database URL, no forge
// token, no customer source. What crosses the boundary between them is this
// document, and every field of it is validated by the runner against its own
// configuration before a runtime is spawned. A request cannot choose the image,
// cannot name a host path, and cannot exceed the wall-clock cap.

/** A path is a single snapshot directory name under the scratch root. */
export const SNAPSHOT_NAME_PATTERN = /^snap-[A-Za-z0-9_-]{1,64}$/;

export const runnerRequestSchema = z.object({
  /** Must equal the runner's own SCAN_IMAGE; anything else is refused. */
  image: z.string().min(1).max(256),
  /** The worker's view of the snapshot dir; the runner translates it. */
  snapshotDir: z.string().min(1).max(1024),
  command: z.array(z.string().min(1).max(16_384)).min(1).max(256),
  budget: z.object({
    wallClockMs: z.number().int().positive(),
    memoryMb: z
      .number()
      .int()
      .positive()
      .max(64 * 1024)
      .optional(),
    cpuMillis: z.number().int().positive().max(64_000).optional(),
  }),
  user: z
    .string()
    .regex(/^\d{1,10}:\d{1,10}$/)
    .optional(),
  pidsLimit: z.number().int().min(1).max(4096).optional(),
  extraMounts: z
    .array(
      z.object({
        /** The worker's view of the host directory; the runner translates it. */
        hostPath: z.string().min(1).max(1024),
        containerPath: z.string().min(1).max(256),
      }),
    )
    .max(8)
    .optional(),
  writablePaths: z.array(z.string().min(1).max(256)).max(8).optional(),
  maxStdoutBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024)
    .optional(),
});

export type RunnerRequest = z.infer<typeof runnerRequestSchema>;

/**
 * What came back from the container, before any parsing. The worker owns the
 * question of whether stdout is a findings document; the runner only owns
 * whether the process ran, ended and stayed inside its budget.
 */
export const runnerResponseSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'timed_out', 'invalid_output']),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export type RunnerResponse = z.infer<typeof runnerResponseSchema>;

/** A refusal: the request was well-formed JSON the runner will not act on. */
export const runnerProblemSchema = z.object({
  error: z.string(),
});

/**
 * GET /v1/status — what this runner can run (acceptance 3: vulnerability
 * database availability and age are visible; unsupported tools are listed).
 */
export const runnerStatusSchema = z.object({
  runtime: z.enum(['podman', 'docker']),
  runtimeBinary: z.string(),
  runtimeVersion: z.string().nullable(),
  image: z.object({ name: z.string(), present: z.boolean().nullable() }),
  scratch: z.object({
    mode: z.enum(['volume', 'bind']),
    source: z.string(),
    hostPath: z.string().nullable(),
  }),
  vulnDb: z.object({
    present: z.boolean(),
    schema: z.string().nullable(),
    builtAt: z.string().nullable(),
    ageDays: z.number().int().nonnegative().nullable(),
    maxAgeDays: z.number().int().positive(),
    stale: z.boolean().nullable(),
    source: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  scanTools: z.array(z.object({ tool: z.string(), usedBy: z.array(z.string()) })),
  unsupportedTools: z.array(z.object({ tool: z.string(), reason: z.string() })),
  sweptOnBoot: z.number().int().nonnegative(),
});

export type RunnerStatus = z.infer<typeof runnerStatusSchema>;

export const RUNNER_RUN_PATH = '/v1/run';
export const RUNNER_STATUS_PATH = '/v1/status';
export const DEFAULT_RUNNER_SOCKET = '/run/repopulse/scan-runner.sock';

/**
 * Where a runner listens, or where a worker finds one: either a unix socket
 * PATH or an http://host:port URL.
 *
 * Both, because they answer different constraints. A unix socket in a shared
 * volume is the tighter boundary and is what tests and non-SELinux hosts use.
 * On an SELinux host it cannot work: the runner must be unconfined
 * (label=disable) to reach the host's podman socket, and a confined worker
 * may not connectto an unconfined listener — measured on Fedora CoreOS
 * (podman machine) as EACCES with mode and ownership both correct. TCP on a
 * compose network that only the worker and runner join is not subject to
 * that check, so the packaged stack uses it, with a bearer token on top.
 */
export type RunnerAddress = { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number };

export function parseRunnerAddress(value: string): RunnerAddress {
  if (value.startsWith('http://') || value.startsWith('tcp://')) {
    const url = new URL(value.replace(/^tcp:/, 'http:'));
    // Port 0 is legal: "any free port", which a test listener uses.
    const port = url.port === '' ? 80 : Number(url.port);
    if (!Number.isInteger(port) || port < 0) throw new Error(`runner address ${value} needs a port`);
    return { kind: 'tcp', host: url.hostname, port };
  }
  if (value.startsWith('unix://')) return { kind: 'unix', path: value.slice('unix://'.length) };
  return { kind: 'unix', path: value };
}

/** HTTP header the token travels in; the runner refuses /v1/run without it when a token is set. */
export const RUNNER_AUTH_HEADER = 'authorization';
