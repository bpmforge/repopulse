import { execFile } from 'node:child_process';
import path from 'node:path';

// Host-side image pulls (W18-34, D8 / C1a).
//
// The sandbox has no network, so images are fetched HERE, on the host, into a
// scratch directory that the scan step mounts read-only and the run deletes.
// skopeo is used rather than a container runtime so no daemon, socket or
// privilege is needed to read a registry, and the image is copied as an
// archive — never run, never unpacked on the host.
//
// CREDENTIALS belong to the self-hoster. A private registry is reached through
// a containers-auth file (`skopeo login --authfile …`), named by
// IMAGE_SCAN_AUTH_FILE. RepoPulse stores no registry credentials and never
// prints the path's contents; the file is read by skopeo alone.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number },
) => Promise<ExecResult>;

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export interface PullOptions {
  exec?: ExecFn;
  authFile?: string | undefined;
  timeoutMs?: number;
}

const authArgs = (opts: PullOptions): string[] => {
  const file = opts.authFile ?? process.env['IMAGE_SCAN_AUTH_FILE'];
  return file ? ['--authfile', file] : [];
};

/** The first lines of a failure, for a run row. Registry errors carry no secrets; tokens never reach stderr. */
const reason = (stderr: string): string => stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);

export type PullResult =
  | { ok: true; archive: string }
  | { ok: false; reason: string };

export async function pullImage(ref: string, destDir: string, opts: PullOptions = {}): Promise<PullResult> {
  const exec = opts.exec ?? defaultExec;
  const archive = path.join(destDir, 'image.tar');
  const result = await exec(
    'skopeo',
    ['copy', ...authArgs(opts), '--override-os', 'linux', `docker://${ref}`, `docker-archive:${archive}`],
    { timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000 },
  );
  if (result.code !== 0) return { ok: false, reason: `skopeo could not pull ${ref}: ${reason(result.stderr)}` };
  return { ok: true, archive };
}

/** Tags a registry lists for `registry/repository`, or null when it will not say. */
export async function listTags(
  registry: string,
  repository: string,
  opts: PullOptions = {},
): Promise<string[] | null> {
  const exec = opts.exec ?? defaultExec;
  const result = await exec(
    'skopeo',
    ['list-tags', ...authArgs(opts), `docker://${registry}/${repository}`],
    { timeoutMs: opts.timeoutMs ?? 60 * 1000 },
  );
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { Tags?: unknown };
    return Array.isArray(parsed.Tags) ? parsed.Tags.filter((t): t is string => typeof t === 'string') : null;
  } catch {
    return null;
  }
}
