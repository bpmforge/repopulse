import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  buildSandboxArgs,
  runtimeEnv,
  runtimeFlavour,
  scanContainerName,
  type SandboxProfileArgs,
} from './profile.js';
import { configuredRunnerAddress, runViaRunner, RunnerUnavailableError } from './runner-client.js';
import type { RunnerResponse } from './runner-protocol.js';
import { spawnSandbox } from './spawn.js';

// The sandbox runner (W8-03, SECURITY_SUITE.md 2.2, NFR-14).
//
// This is the ONLY place in the codebase allowed to spawn a scan tool -
// validate-arch rule 7 fails the build if a spawn/exec of one appears anywhere
// else, because a tool run outside this file is a tool run outside the profile.
//
// Findings leave the container as JSON on stdout and are schema-validated
// before anything downstream sees them. Not because the tool is expected to
// lie, but because the tool is parsing attacker-influenced source: its output
// is downstream of the same input the sandbox exists to contain.
//
// TWO WAYS TO REACH A RUNTIME (W17-27). On a dev checkout the runtime is on
// this machine's PATH and is spawned here. In the packaged stack the worker
// has no runtime and no socket — on purpose — and hands the same profile to
// the scan-runner sidecar over a unix socket (runner-client.ts). Which one is
// decided by SCAN_RUNNER_URL / SCAN_RUNNER_SOCKET alone; the scanners above
// this line do not know the difference, and the profile they get is
// byte-identical either way.

export const sandboxOutputSchema = z.object({
  findings: z
    .array(
      z.object({
        ruleId: z.string().min(1),
        file: z.string().min(1),
        lineStart: z.number().int().nonnegative(),
        lineEnd: z.number().int().nonnegative(),
        severity: z.number().int().min(1).max(5),
        title: z.string().min(1),
        evidence: z.string(),
      }),
    )
    .max(10_000),
});

export type SandboxOutput = z.infer<typeof sandboxOutputSchema>;

export type SandboxStatus = 'succeeded' | 'failed' | 'timed_out' | 'invalid_output';

export interface SandboxRunResult {
  status: SandboxStatus;
  exitCode: number | null;
  output?: SandboxOutput;
  /**
   * Everything the tool wrote to stdout (W8-07).
   *
   * Returned always, because not every scan tool speaks our findings schema:
   * Opengrep emits its own JSON and the scanner that owns it does the parsing.
   * The sandbox's job is to contain the process, not to be the only reader of
   * what comes out of it.
   */
  rawStdout?: string;
  /** Truncated stderr, kept for the operator - never parsed for findings. */
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface RunInSandboxOptions extends SandboxProfileArgs {
  /**
   * Container runtime binary for the LOCAL path: podman (default) or docker.
   * The argv is built for whichever it is (profile.ts). Ignored when a runner
   * socket is in use — the runner has its own runtime.
   */
  runtime?: string;
  /**
   * The scan-runner's address — a unix socket path or http://host:port.
   * Defaults to $SCAN_RUNNER_URL / $SCAN_RUNNER_SOCKET; when none is set the
   * runtime is spawned locally.
   */
  runner?: string;
  /** Test seam. Prod always spawns. */
  spawnFn?: typeof spawn;
  /** Stdout cap - a tool that emits gigabytes is a tool that gets cut off. */
  maxStdoutBytes?: number;
  /**
   * Validate stdout against the findings schema. Off for tools with their own
   * output format, whose scanner parses and validates it instead — the
   * validation still happens, one layer out.
   */
  parseOutput?: boolean;
}

export async function runInSandbox(opts: RunInSandboxOptions): Promise<SandboxRunResult> {
  const runner = opts.runner ?? configuredRunnerAddress();
  const containerName = opts.containerName ?? scanContainerName();

  let raw: RunnerResponse;
  if (runner !== undefined && opts.spawnFn === undefined) {
    try {
      raw = await runViaRunner(runner, {
        image: opts.image,
        snapshotDir: opts.snapshotDir,
        command: [...opts.command],
        budget: {
          wallClockMs: opts.budget.wallClockMs,
          ...(opts.budget.memoryMb !== undefined ? { memoryMb: opts.budget.memoryMb } : {}),
          ...(opts.budget.cpuMillis !== undefined ? { cpuMillis: opts.budget.cpuMillis } : {}),
        },
        ...(opts.user !== undefined ? { user: opts.user } : {}),
        ...(opts.pidsLimit !== undefined ? { pidsLimit: opts.pidsLimit } : {}),
        ...(opts.extraMounts ? { extraMounts: [...opts.extraMounts] } : {}),
        ...(opts.writablePaths ? { writablePaths: [...opts.writablePaths] } : {}),
        ...(opts.maxStdoutBytes !== undefined ? { maxStdoutBytes: opts.maxStdoutBytes } : {}),
      });
    } catch (err) {
      // An unreachable runner is a deployment fact, recorded on the run the
      // way a missing image is — never a clean result and never a crash.
      const message = err instanceof RunnerUnavailableError ? err.message : (err as Error).message;
      return { status: 'failed', exitCode: null, stderr: '', durationMs: 0, error: message };
    }
  } else {
    const runtime = opts.runtime ?? 'podman';
    raw = await spawnSandbox({
      runtimeBinary: runtime,
      argv: buildSandboxArgs({ ...opts, containerName }, runtimeFlavour(runtime)),
      containerName,
      wallClockMs: opts.budget.wallClockMs,
      ...(opts.maxStdoutBytes !== undefined ? { maxStdoutBytes: opts.maxStdoutBytes } : {}),
      // PATH only, and only so the RUNTIME binary can be found — the container
      // itself inherits nothing from this process (see runtimeEnv).
      env: runtimeEnv(),
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    });
  }

  return finalize(raw, opts.parseOutput);
}

/** Turns what the container did into what a scanner reads. */
export function finalize(raw: RunnerResponse, parseOutput: boolean | undefined): SandboxRunResult {
  const base = { exitCode: raw.exitCode, stderr: raw.stderr, durationMs: raw.durationMs };
  if (raw.status === 'timed_out') {
    return { ...base, status: 'timed_out', ...(raw.error ? { error: raw.error } : {}) };
  }
  if (raw.status === 'invalid_output') {
    return { ...base, status: 'invalid_output', ...(raw.error ? { error: raw.error } : {}) };
  }
  if (raw.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      // Only a process that actually ran has stdout worth handing back; a
      // spawn error or a runner refusal has none, and an empty string here
      // would read to a scanner as "the tool ran and printed nothing".
      ...(raw.exitCode !== null ? { rawStdout: raw.stdout } : {}),
      ...(raw.error ? { error: raw.error } : {}),
    };
  }
  if (parseOutput === false) {
    return { ...base, status: 'succeeded', rawStdout: raw.stdout };
  }
  const parsed = parseSandboxOutput(raw.stdout);
  if (!parsed.ok) {
    // A tool that emitted something we cannot validate has produced no
    // findings, not zero findings. Reporting the latter would let a broken
    // scanner render a repo clean.
    return { ...base, status: 'invalid_output', rawStdout: raw.stdout, error: parsed.error };
  }
  return { ...base, status: 'succeeded', output: parsed.value, rawStdout: raw.stdout };
}

/**
 * The tail of a tool's stderr, for an error message a person will read (W16-37).
 *
 * Read from the END because a tool that logged progress before dying buries
 * its reason at the bottom — and capped, because this is untrusted output from
 * third-party code that lands in a scan_run row a screen renders.
 *
 * The cap is applied with an explicit ellipsis rather than a bare slice: the
 * first version cut mid-word and the message began "epopulse/does-not-exist",
 * which reads as a rendering bug rather than a truncation.
 */
export function stderrTail(stderr: string, lines = 2, cap = 300): string {
  const text = stderr.trim();
  if (text === '') return '';
  const tail = text.split('\n').slice(-lines).join(' ').trim();
  return tail.length <= cap ? tail : `…${tail.slice(-cap)}`;
}

export function parseSandboxOutput(
  stdout: string,
): { ok: true; value: SandboxOutput } | { ok: false; error: string } {
  const trimmed = stdout.trim();
  if (trimmed === '') return { ok: false, error: 'scanner produced no output' };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `stdout was not JSON: ${(err as Error).message}` };
  }
  const result = sandboxOutputSchema.safeParse(json);
  if (!result.success) return { ok: false, error: result.error.issues[0]?.message ?? 'invalid' };
  return { ok: true, value: result.data };
}
