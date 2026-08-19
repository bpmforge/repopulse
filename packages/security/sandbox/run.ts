import { spawn } from 'node:child_process';
import { z } from 'zod';
import { buildSandboxArgs, sandboxEnv, type SandboxProfileArgs } from './profile.js';

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
  /** Truncated stderr, kept for the operator - never parsed for findings. */
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface RunInSandboxOptions extends SandboxProfileArgs {
  /** Container runtime binary. Podman by default; docker works with the same argv. */
  runtime?: string;
  /** Test seam. Prod always spawns. */
  spawnFn?: typeof spawn;
  /** Stdout cap - a tool that emits gigabytes is a tool that gets cut off. */
  maxStdoutBytes?: number;
}

const STDERR_KEEP = 4000;

export async function runInSandbox(opts: RunInSandboxOptions): Promise<SandboxRunResult> {
  const runtime = opts.runtime ?? 'podman';
  const spawnImpl = opts.spawnFn ?? spawn;
  const maxStdout = opts.maxStdoutBytes ?? 32 * 1024 * 1024;
  const argv = buildSandboxArgs(opts);
  const startedAt = Date.now();

  return await new Promise<SandboxRunResult>((resolve) => {
    // An empty env, not a filtered one: see profile.ts.
    const child = spawnImpl(runtime, argv, {
      env: sandboxEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let overflowed = false;
    let settled = false;

    const finish = (result: Omit<SandboxRunResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        status: 'timed_out',
        exitCode: null,
        stderr: stderr.slice(-STDERR_KEEP),
        error: `scan exceeded ${opts.budget.wallClockMs}ms`,
      });
    }, opts.budget.wallClockMs);
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
      finish({ status: 'failed', exitCode: null, stderr, error: err.message });
    });

    child.on('close', (code: number | null) => {
      if (overflowed) {
        finish({ status: 'invalid_output', exitCode: code, stderr, error: 'stdout cap exceeded' });
        return;
      }
      if (code !== 0) {
        finish({ status: 'failed', exitCode: code, stderr, error: `exit ${String(code)}` });
        return;
      }
      const parsed = parseSandboxOutput(stdout);
      if (!parsed.ok) {
        // A tool that emitted something we cannot validate has produced no
        // findings, not zero findings. Reporting the latter would let a broken
        // scanner render a repo clean.
        finish({ status: 'invalid_output', exitCode: code, stderr, error: parsed.error });
        return;
      }
      finish({ status: 'succeeded', exitCode: code, output: parsed.value, stderr });
    });
  });
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
