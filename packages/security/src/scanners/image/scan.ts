import { SCAN_MOUNT_PATH } from '../../../sandbox/profile.js';
import { runInSandbox, stderrTail, type RunInSandboxOptions } from '../../../sandbox/run.js';
import type { ScanBudget } from '../../framework/types.js';
import { checkVulnDb, vulnDbDir, VULN_DB_MOUNT_PATH } from '../dependency/tools.js';
import { parseGrypeMatches, type DependencyMatch } from '../dependency/matches.js';

// grype over a pulled image archive, in the network-less sandbox (W18-34).
//
// The same discipline as the dependency scanner: the exit code is echoed and
// checked, a missing marker is a failed run and never an empty one, and the
// vulnerability database is mounted read-only from the host.

const EXIT_MARKER = 'GRYPE_EXIT=';

export interface ImageScanArgs {
  /** Host directory containing `image.tar`. */
  archiveDir: string;
  image: string;
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  runtime?: string;
  vulnDb?: string;
  spawnFn?: RunInSandboxOptions['spawnFn'];
}

export type ImageScanResult =
  | { status: 'succeeded'; matches: DependencyMatch[]; grypeVersion: string | null }
  | { status: 'failed'; error: string };

export async function scanImageArchive(args: ImageScanArgs): Promise<ImageScanResult> {
  const vulnDb = args.vulnDb ?? vulnDbDir();
  const dbCheck = checkVulnDb(vulnDb);
  if (!dbCheck.ok) return { status: 'failed', error: dbCheck.reason };

  const result = await runInSandbox({
    image: args.image,
    snapshotDir: args.archiveDir,
    ...(args.runtime ? { runtime: args.runtime } : {}),
    ...(args.spawnFn ? { spawnFn: args.spawnFn } : {}),
    extraMounts: [{ hostPath: vulnDb, containerPath: VULN_DB_MOUNT_PATH }],
    budget: args.budget,
    parseOutput: false,
    command: [
      'sh',
      '-c',
      `grype docker-archive:${SCAN_MOUNT_PATH}/image.tar -o json; echo "${EXIT_MARKER}$?"`,
    ],
  });
  if (result.rawStdout === undefined) return { status: 'failed', error: result.error ?? result.status };

  const at = result.rawStdout.lastIndexOf(EXIT_MARKER);
  const code = at === -1 ? null : Number(/-?\d+/.exec(result.rawStdout.slice(at + EXIT_MARKER.length))?.[0]);
  if (code === null || Number.isNaN(code)) return { status: 'failed', error: 'grype did not report an exit code' };
  if (code !== 0) {
    const tail = stderrTail(result.stderr, 3);
    return { status: 'failed', error: `grype exited ${code}${tail === '' ? '' : `: ${tail}`}` };
  }
  try {
    const parsed = parseGrypeMatches(result.rawStdout.slice(0, at));
    return { status: 'succeeded', matches: parsed.matches, grypeVersion: parsed.grypeVersion ?? null };
  } catch (error) {
    return { status: 'failed', error: `grype output could not be read: ${(error as Error).message.slice(0, 200)}` };
  }
}
