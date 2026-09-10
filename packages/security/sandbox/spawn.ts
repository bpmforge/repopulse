import { spawn } from 'node:child_process';
import type { RunnerResponse } from './runner-protocol.js';

// The one place a container runtime is actually spawned for a scan (W17-27).
//
// Shared by the local path (run.ts, a dev checkout with podman on the host)
// and the packaged path (runner-server.ts, the scan-runner sidecar). Both used
// to have their own copy of the timer-and-collect loop; a fix to one is a fix
// to the other now.

const STDERR_KEEP = 4000;

export interface SpawnSandboxOptions {
  /** Runtime binary: podman, podman-remote, docker, or a path to one. */
  runtimeBinary: string;
  /** Flags that go BEFORE `run` — `--url unix://...` for a remote socket. */
  globalArgs?: readonly string[];
  /** The profile argv, starting at `run`. */
  argv: readonly string[];
  /** The container name in argv, so a timed-out container can be removed. */
  containerName?: string;
  wallClockMs: number;
  maxStdoutBytes?: number;
  env: Record<string, string>;
  /** Test seam. Prod always spawns. */
  spawnFn?: typeof spawn;
}

/**
 * Removes a container by name, best effort, with its own short deadline.
 *
 * Called after a timeout. SIGKILL on the attached client does not stop the
 * container under either runtime — the container is the daemon's process, not
 * the client's — so without this a timed-out scan keeps running against the
 * snapshot until the runtime's own limits catch it, which docker has none of.
 * Also called after any exit under docker, where `--rm` leaves a container
 * behind if the client was killed mid-attach.
 */
export function removeContainer(opts: {
  runtimeBinary: string;
  globalArgs?: readonly string[];
  containerName: string;
  env: Record<string, string>;
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}): Promise<boolean> {
  const spawnImpl = opts.spawnFn ?? spawn;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(
        opts.runtimeBinary,
        [...(opts.globalArgs ?? []), 'rm', '--force', opts.containerName],
        { env: opts.env, stdio: 'ignore' },
      );
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, opts.timeoutMs ?? 15_000);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** Runs one container to completion or to its wall-clock limit. */
export async function spawnSandbox(opts: SpawnSandboxOptions): Promise<RunnerResponse> {
  const spawnImpl = opts.spawnFn ?? spawn;
  const maxStdout = opts.maxStdoutBytes ?? 32 * 1024 * 1024;
  const startedAt = Date.now();

  const raw = await new Promise<Omit<RunnerResponse, 'durationMs'>>((resolve) => {
    const child = spawnImpl(opts.runtimeBinary, [...(opts.globalArgs ?? []), ...opts.argv], {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let overflowed = false;
    let settled = false;

    const finish = (result: Omit<RunnerResponse, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        status: 'timed_out',
        exitCode: null,
        stdout,
        stderr: stderr.slice(-STDERR_KEEP),
        error: `scan exceeded ${opts.wallClockMs}ms`,
      });
    }, opts.wallClockMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length > maxStdout) {
        overflowed = true;
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });

    child.on('error', (err: Error) => {
      finish({ status: 'failed', exitCode: null, stdout, stderr, error: err.message });
    });

    child.on('close', (code: number | null) => {
      if (overflowed) {
        finish({
          status: 'invalid_output',
          exitCode: code,
          stdout,
          stderr,
          error: 'stdout cap exceeded',
        });
        return;
      }
      if (code !== 0) {
        finish({ status: 'failed', exitCode: code, stdout, stderr, error: `exit ${String(code)}` });
        return;
      }
      finish({ status: 'succeeded', exitCode: code, stdout, stderr });
    });
  });

  if (raw.status === 'timed_out' && opts.containerName) {
    // The container outlives the client we just killed. Remove it by name and
    // WAIT for that, so the caller's snapshot `finally` does not delete a
    // directory a container is still reading.
    await removeContainer({
      runtimeBinary: opts.runtimeBinary,
      ...(opts.globalArgs ? { globalArgs: opts.globalArgs } : {}),
      containerName: opts.containerName,
      env: opts.env,
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    });
  }

  return { ...raw, durationMs: Date.now() - startedAt };
}
