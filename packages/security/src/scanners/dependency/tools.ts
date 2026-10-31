import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCAN_MOUNT_PATH } from '../../../sandbox/profile.js';
import { runInSandbox, stderrTail, type RunInSandboxOptions } from '../../../sandbox/run.js';
import type { ScanBudget } from '../../framework/types.js';
import { parseGrypeMatches, type DependencyMatch, type MatchFunnel } from './matches.js';

// syft + grype in the sandbox (W8-06, SECURITY_SUITE.md §3.2, NFR-14).
//
// Both tools clear the §10 admission filter for the same reason lizard does:
// they read files and compare them against data they already have. syft parses
// manifests and lockfiles; grype compares the resulting component list against
// a database mounted read-only. Neither resolves anything over the network,
// which is what lets them run under --network=none over someone else's source.
//
// The DATABASE is the part that is not in the image, and deliberately: it
// aggregates 26 upstream feeds each under its own terms, so we are not entitled
// to redistribute it. deploy/scan-db-sync.sh fetches it host-side into
// $SCAN_RULES_DIR/vuln-db, and this file mounts that directory at the path the
// image's GRYPE_DB_CACHE_DIR already points to.

/** Mount point of the vulnerability database, matching the image's ENV. */
export const VULN_DB_MOUNT_PATH = '/vuln-db';

/** SBOM path inside the container — the profile's tmpfs, so no new mount. */
const SBOM_PATH = '/tmp/sbom.json';
/**
 * The copy of the SBOM grype reads (W18-51). syft's own document stays at
 * SBOM_PATH and is what the caller gets back; only grype's input is changed,
 * by the normaliser baked into the scan image.
 */
const GRYPE_SBOM_PATH = '/tmp/sbom.grype.json';
const NORMALISER_PATH = '/opt/scan-tools/sbom-normalise.mjs';

const SBOM_MARKER = '===SBOM===';
const GRYPE_MARKER = '===GRYPE===';

/**
 * Where the host keeps the synced database.
 *
 * Same env var and same default as deploy/scan-db-sync.sh, because the two are
 * one contract: a second default here would produce an install where the sync
 * job writes a database the scanner never looks at, and the symptom would be a
 * repository that reports no vulnerabilities.
 */
export function vulnDbDir(): string {
  return path.join(process.env.SCAN_RULES_DIR ?? '/var/lib/repopulse/scan-rules', 'vuln-db');
}

export type VulnDbCheck = { ok: true; schema: string } | { ok: false; reason: string };

/**
 * Is there a database to scan against?
 *
 * Checked BEFORE a container starts, and a failure here fails the scan. grype
 * with no database does not error in a way anyone would notice — it reports
 * nothing — and a repository with no findings is indistinguishable from a
 * repository nobody checked. That equivalence is the specific bug this function
 * exists to prevent.
 */
export function checkVulnDb(dir: string): VulnDbCheck {
  if (!existsSync(dir)) {
    return {
      ok: false,
      reason: `no vulnerability database at ${dir} — run deploy/scan-db-sync.sh`,
    };
  }
  // grype lays the database out as <cache>/<schema>/vulnerability.db, and the
  // schema directory is the tool's own version number, so it is discovered
  // rather than pinned here: pinning it would break the day grype's own
  // upgrade changes it, and the failure would look like an empty scan.
  for (const entry of readdirSync(dir)) {
    if (!existsSync(path.join(dir, entry, 'vulnerability.db'))) continue;
    const age = ageOf(path.join(dir, entry));
    // STALE IS ITS OWN ANSWER (W16-36).
    //
    // grype refuses a database older than five days and exits 1 — and it says
    // why only on stderr, which did not survive the sandbox: the first real
    // run of this scanner reported "grype exited 1" to the screen and nothing
    // else. A present-but-refused database is the same shape of problem as an
    // absent one, so it is checked in the same place and answered in the same
    // words: what is wrong, and the command that fixes it.
    if (age !== null && age > MAX_DB_AGE_DAYS) {
      return {
        ok: false,
        reason:
          `the vulnerability database is ${age} days old and grype refuses one over ` +
          `${MAX_DB_AGE_DAYS} — run deploy/scan-db-sync.sh`,
      };
    }
    return { ok: true, schema: entry };
  }
  return {
    ok: false,
    reason: `${dir} exists but holds no <schema>/vulnerability.db — the sync did not finish`,
  };
}

/**
 * grype's own default maximum database age, in days.
 *
 * Mirrored rather than discovered because grype does not expose it, and a
 * number that drifts from the tool's is better than no check: too strict here
 * means an early, actionable failure instead of `grype exited 1`, and too
 * lenient means the behaviour we have today.
 */
const MAX_DB_AGE_DAYS = 5;

/**
 * How old the imported database is, from grype's OWN record of it.
 *
 * `import.json` holds the source URL it was built from, and that URL carries
 * the build timestamp — which is what grype itself compares against. The file
 * mtime is deliberately not used: `scan-db-sync.sh` copies the directory, so
 * mtime is when it was COPIED, and a fresh copy of a stale database would
 * report as new.
 *
 * Returns null when the record cannot be read, and the caller then proceeds:
 * a database this function cannot date is not thereby a database that is old,
 * and refusing to scan on that basis would be its own false alarm.
 */
function ageOf(schemaDir: string): number | null {
  try {
    const raw = readFileSync(path.join(schemaDir, 'import.json'), 'utf8');
    const source = (JSON.parse(raw) as { source?: string }).source ?? '';
    const stamp = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(source)?.[1];
    if (!stamp) return null;
    const built = Date.parse(stamp);
    if (Number.isNaN(built)) return null;
    return Math.floor((Date.now() - built) / 86_400_000);
  } catch {
    return null;
  }
}

export interface DependencyToolsArgs {
  targetDir: string;
  image: string;
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  runtime?: string;
  /** Host directory holding the grype database. Defaults to vulnDbDir(). */
  vulnDb?: string;
  /**
   * Test seam, passed straight through to the sandbox runner. Production
   * always spawns — it exists so the "a tool died" paths below can be exercised
   * without a container, which is the half of this file that must never regress.
   */
  spawnFn?: RunInSandboxOptions['spawnFn'];
}

export interface DependencyToolsResult {
  status: 'succeeded' | 'failed';
  /** The CycloneDX document, exactly as syft emitted it. */
  document: Record<string, unknown> | null;
  matches: DependencyMatch[];
  matchFunnel: MatchFunnel | null;
  /** Components in the document — the document's own count, not our subset. */
  componentCount: number;
  toolVersions: Record<string, string>;
  error?: string;
}

/** Everything after the last newline-delimited `KEY=value` marker in a chunk. */
function readExitCode(text: string, key: string): number | null {
  const match = new RegExp(`${key}=(-?\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

const failure = (error: string, toolVersions: Record<string, string>): DependencyToolsResult => ({
  status: 'failed',
  document: null,
  matches: [],
  matchFunnel: null,
  componentCount: 0,
  toolVersions,
  error,
});

/**
 * Runs both tools in ONE container, and never as a pipeline.
 *
 * `syft ... | grype` works and was the first thing tried. It is also the exact
 * shape of the bug requirement 4 names: busybox sh has no `pipefail` and a
 * pipeline's status is its LAST command's, so a syft that died would hand grype
 * an empty stdin, and grype would exit 0 having matched nothing. A repository
 * would come back clean because the SBOM step crashed.
 *
 * So the SBOM goes to a file on the tmpfs, each step's exit code is echoed
 * explicitly, and both are checked before anything is parsed.
 */
export async function runDependencyTools(
  args: DependencyToolsArgs,
): Promise<DependencyToolsResult> {
  const toolVersions: Record<string, string> = { syft: 'unknown', grype: 'unknown' };
  const vulnDb = args.vulnDb ?? vulnDbDir();

  const dbCheck = checkVulnDb(vulnDb);
  if (!dbCheck.ok) return failure(dbCheck.reason, toolVersions);

  const result = await runInSandbox({
    image: args.image,
    snapshotDir: args.targetDir,
    ...(args.runtime ? { runtime: args.runtime } : {}),
    ...(args.spawnFn ? { spawnFn: args.spawnFn } : {}),
    // ro,noexec like every other mount the profile makes. grype opens the
    // sqlite database read-only and needs no sidecar file to do it — verified
    // by running `grype db status` under this exact profile.
    extraMounts: [{ hostPath: vulnDb, containerPath: VULN_DB_MOUNT_PATH }],
    budget: args.budget,
    // Both tools speak their own JSON; the parsers below validate it, which is
    // the same arrangement the Opengrep scanner has.
    parseOutput: false,
    command: [
      'sh',
      '-c',
      // NO `-q` ON EITHER TOOL (W16-37).
      //
      // Both were quiet, and `-q` silences a FATAL error as thoroughly as it
      // silences a progress bar. The first real run of this scanner failed
      // with `grype exited 1` and an empty stderr — the sandbox had captured
      // stderr correctly and grype had written nothing to it. Verified by
      // hand: with `-q`, zero bytes; without it, "failed to load vulnerability
      // db: the vulnerability database was built 1 week ago (max allowed age
      // is 5 days)".
      //
      // Safe for the parsers, and checked rather than assumed: both tools put
      // their REPORT on stdout (syft's goes to a file here) and their logs on
      // stderr, so dropping the flag adds nothing to the stream these markers
      // split. stderr is capped at 4000 chars and read from the END, because a
      // tool that logged progress before dying buries its reason at the bottom.
      [
        `syft scan dir:${SCAN_MOUNT_PATH} -o cyclonedx-json=${SBOM_PATH}`,
        `echo "SYFT_EXIT=$?"`,
        // Its exit is echoed and checked like the other two: a normaliser that
        // died must fail the scan, not hand grype the un-normalised document.
        `node ${NORMALISER_PATH} ${SBOM_PATH} ${GRYPE_SBOM_PATH}`,
        `echo "NORMALISE_EXIT=$?"`,
        `echo '${SBOM_MARKER}'`,
        `cat ${SBOM_PATH} 2>/dev/null`,
        `echo '${GRYPE_MARKER}'`,
        `grype sbom:${GRYPE_SBOM_PATH} -o json`,
        `echo "GRYPE_EXIT=$?"`,
      ].join('; '),
    ],
  });

  if (result.rawStdout === undefined) {
    return failure(result.error ?? result.status, toolVersions);
  }

  const [head = '', rest = ''] = splitOnce(result.rawStdout, SBOM_MARKER);
  const [sbomText = '', grypeText = ''] = splitOnce(rest, GRYPE_MARKER);

  const syftExit = readExitCode(head, 'SYFT_EXIT');
  const normaliseExit = readExitCode(head, 'NORMALISE_EXIT');
  const grypeExit = readExitCode(grypeText, 'GRYPE_EXIT');

  /**
   * THE TOOL'S OWN REASON, not just its exit code (W16-36).
   *
   * `grype exited 1` was the whole message a reader got, and it is the same
   * unactionable shape as "(not installed)": true, and no use. The first real
   * run of this scanner failed with it — and grype's stderr said exactly what
   * was wrong and what to do about it:
   *
   *   failed to load vulnerability db: the vulnerability database was built
   *   1 week ago (max allowed age is 5 days)
   *
   * The sandbox has captured stderr all along (`SandboxResult.stderr`, kept
   * "for the operator") and this file discarded it at the one point an
   * operator needed it.
   *
   * Capped, because stderr is untrusted output from a third-party tool and
   * this string lands in a scan_run row that a screen renders.
   */
  const detail = (): string => {
    const tail = stderrTail(result.stderr, 3);
    return tail === '' ? '' : `: ${tail}`;
  };

  // A missing marker means the shell never reached that line — truncated
  // output or a killed container, which is a failed run and not an empty one.
  if (syftExit === null) return failure('syft did not report an exit code', toolVersions);
  if (syftExit !== 0) return failure(`syft exited ${syftExit}${detail()}`, toolVersions);
  if (normaliseExit === null) {
    return failure('the SBOM normaliser did not report an exit code', toolVersions);
  }
  if (normaliseExit !== 0) {
    return failure(`the SBOM normaliser exited ${normaliseExit}${detail()}`, toolVersions);
  }
  if (grypeExit === null) return failure('grype did not report an exit code', toolVersions);
  if (grypeExit !== 0) return failure(`grype exited ${grypeExit}${detail()}`, toolVersions);

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(sbomText.trim()) as Record<string, unknown>;
  } catch (error) {
    return failure(`SBOM was not JSON: ${(error as Error).message.slice(0, 200)}`, toolVersions);
  }

  toolVersions.syft = syftVersion(document) ?? 'unknown';

  let parsed;
  try {
    parsed = parseGrypeMatches(grypeText.slice(0, grypeText.lastIndexOf('GRYPE_EXIT=')));
  } catch (error) {
    return failure(
      `grype output could not be read: ${(error as Error).message.slice(0, 200)}`,
      toolVersions,
    );
  }
  toolVersions.grype = parsed.grypeVersion ?? 'unknown';

  return {
    status: 'succeeded',
    document,
    matches: parsed.matches,
    matchFunnel: parsed.funnel,
    // The DOCUMENT's own component count, which is not the same number as the
    // one the supply-chain registers see: readComponents admits only npm and
    // pypi purls, and owasp_llm reads the document with its own reader again.
    // Storing the document's count keeps the column meaning "what is in this
    // SBOM" rather than "what one consumer could parse out of it".
    componentCount: Array.isArray(document['components']) ? document['components'].length : 0,
    toolVersions,
  };
}

function splitOnce(text: string, marker: string): [string, string] {
  const at = text.indexOf(marker);
  if (at === -1) return [text, ''];
  return [text.slice(0, at), text.slice(at + marker.length)];
}

/** syft stamps itself into the CycloneDX metadata, so the version is the real one. */
function syftVersion(document: Record<string, unknown>): string | null {
  const metadata = document['metadata'] as { tools?: unknown } | undefined;
  const tools = metadata?.tools;
  const components = Array.isArray(tools)
    ? tools
    : ((tools as { components?: unknown[] } | undefined)?.components ?? []);
  for (const entry of components as { name?: unknown; version?: unknown }[]) {
    if (entry?.name === 'syft' && typeof entry.version === 'string') return entry.version;
  }
  return null;
}

export interface GrypeOnSbomArgs {
  /** The stored CycloneDX document — exactly what `runDependencyTools` returned. */
  document: Record<string, unknown>;
  image: string;
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  runtime?: string;
  vulnDb?: string;
  spawnFn?: RunInSandboxOptions['spawnFn'];
}

export interface GrypeOnSbomResult {
  status: 'succeeded' | 'failed';
  matches: DependencyMatch[];
  matchFunnel: MatchFunnel | null;
  toolVersions: Record<string, string>;
  error?: string;
}

/**
 * grype over a STORED SBOM, with no source tree (W23-04 rematch).
 *
 * The advisory database moved and the manifests did not, so the component list
 * is still right and only the matching is stale. The SBOM is written to a
 * scratch directory that takes the place of the snapshot mount, then goes
 * through the same normaliser and the same grype invocation as the full path —
 * and under the same profile (--network=none, read-only database). Same
 * discipline as `runDependencyTools`: each step's exit code is echoed and
 * checked, never piped, so a normaliser that died cannot hand grype nothing and
 * read as a clean repository.
 */
export async function runGrypeOnSbom(args: GrypeOnSbomArgs): Promise<GrypeOnSbomResult> {
  const toolVersions: Record<string, string> = { grype: 'unknown' };
  const fail = (error: string): GrypeOnSbomResult => ({
    status: 'failed',
    matches: [],
    matchFunnel: null,
    toolVersions,
    error,
  });
  const vulnDb = args.vulnDb ?? vulnDbDir();
  const dbCheck = checkVulnDb(vulnDb);
  if (!dbCheck.ok) return fail(dbCheck.reason);

  const scratch = mkdtempSync(path.join(tmpdir(), 'repopulse-rematch-'));
  try {
    // The container runs as an unprivileged user; mkdtemp's 0700 would hide it.
    chmodSync(scratch, 0o755);
    const sbomFile = path.join(scratch, 'sbom.json');
    writeFileSync(sbomFile, JSON.stringify(args.document), { mode: 0o644 });

    const result = await runInSandbox({
      image: args.image,
      snapshotDir: scratch,
      ...(args.runtime ? { runtime: args.runtime } : {}),
      ...(args.spawnFn ? { spawnFn: args.spawnFn } : {}),
      extraMounts: [{ hostPath: vulnDb, containerPath: VULN_DB_MOUNT_PATH }],
      budget: args.budget,
      parseOutput: false,
      command: [
        'sh',
        '-c',
        [
          `node ${NORMALISER_PATH} ${SCAN_MOUNT_PATH}/sbom.json ${GRYPE_SBOM_PATH}`,
          `echo "NORMALISE_EXIT=$?"`,
          `echo '${GRYPE_MARKER}'`,
          `grype sbom:${GRYPE_SBOM_PATH} -o json`,
          `echo "GRYPE_EXIT=$?"`,
        ].join('; '),
      ],
    });
    if (result.rawStdout === undefined) return fail(result.error ?? result.status);

    const [head = '', grypeText = ''] = splitOnce(result.rawStdout, GRYPE_MARKER);
    const normaliseExit = readExitCode(head, 'NORMALISE_EXIT');
    const grypeExit = readExitCode(grypeText, 'GRYPE_EXIT');
    const tail = stderrTail(result.stderr, 3);
    const detail = tail === '' ? '' : `: ${tail}`;
    if (normaliseExit === null) return fail('the SBOM normaliser did not report an exit code');
    if (normaliseExit !== 0) return fail(`the SBOM normaliser exited ${normaliseExit}${detail}`);
    if (grypeExit === null) return fail('grype did not report an exit code');
    if (grypeExit !== 0) return fail(`grype exited ${grypeExit}${detail}`);

    let parsed;
    try {
      parsed = parseGrypeMatches(grypeText.slice(0, grypeText.lastIndexOf('GRYPE_EXIT=')));
    } catch (error) {
      return fail(`grype output could not be read: ${(error as Error).message.slice(0, 200)}`);
    }
    toolVersions.grype = parsed.grypeVersion ?? 'unknown';
    return {
      status: 'succeeded',
      matches: parsed.matches,
      matchFunnel: parsed.funnel,
      toolVersions,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
