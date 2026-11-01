// Tool adapter contract (W9-08, CODE_HEALTH_SUITE.md §10, FR-CH-10).
//
// The claim this contract has to earn: adding a tool is ONE adapter file and
// one registry line, touching zero scanner or framework code. That only holds
// if the framework never branches on a tool key — every decision (does this
// tool apply, what command does it run, how is its output read) is asked of the
// adapter.
//
// THE ADMISSION FILTER IS THE SANDBOX. A tool qualifies only if it parses
// source standalone: no network, no `npm install`, no `pip install`, no
// language server. That rules out a lot of good tools, and it is not
// negotiable — the container has --network=none because it is running
// third-party binaries over someone else's source.

export interface AdapterFinding {
  /** `tool.{key}.{rule}` — namespaced so two tools cannot collide. */
  ruleId: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: number;
  title: string;
  message: string;
  /**
   * Which of our dimensions this belongs in. `iac` is the reserved scanner
   * dimension (SECURITY_SUITE.md §7) — checkov's misconfigurations land there
   * so they sit beside the other security findings rather than under code
   * health, where a public database would read as a style problem.
   */
  dimension: 'code_health' | 'correctness' | 'iac';
  /** The tool's own rule identifier, for the dedup mapping table. */
  nativeRule: string;
}

export interface AdapterContext {
  /** Path the tool sees inside the container. */
  mountPath: string;
  /** Relative paths present in the snapshot — what detect() reasons about. */
  files: readonly string[];
}

export interface ToolAdapter {
  key: string;
  version: string;
  license: string;
  /**
   * What one run of this tool depends on (W23-03, incremental scans).
   *
   *   'file'  each finding is a property of ONE file: run over only the files a
   *           commit changed, carry the rest forward, and the answer is the same
   *           as a full run's.
   *   'tree'  a finding can depend on other files (cross-file analysis, a render
   *           of a whole directory): one changed file can change the answer for
   *           files that did not change, so the tool cannot be made incremental
   *           honestly. Absent means 'tree': the safe reading for an adapter
   *           nobody has classified.
   *
   * A scan whose changed files, or whose last full run, involve any 'tree'
   * adapter is planned FULL. Declared here so that adding an adapter states it.
   */
  scope?: 'file' | 'tree';
  /**
   * Does this tool apply to this snapshot?
   *
   * Language routing lives here rather than in the scanner: running Biome over
   * a Python repository produces nothing and costs a container start, and
   * running ruff over a JavaScript one produces nothing and looks like a
   * scanner that does not work.
   */
  detect(ctx: AdapterContext): boolean;
  /** Argv, run standalone inside the sandbox. */
  command(ctx: AdapterContext): string[];
  /** Reads the tool's stdout. Never throws — an unparseable run is empty. */
  parse(stdout: string, ctx: AdapterContext): AdapterFinding[];
  /**
   * Ships its findings as shadow-mode CANDIDATES (§8.2): stamped experimental
   * unless the workspace's rule_registry row for the finding's rule id says
   * `active`, and dropped when it says `deprecated`.
   *
   * Opt-in per adapter rather than global because ruff and Biome went live
   * before the lifecycle existed, and silently demoting their findings to
   * shadow would take numbers off dashboards people already read. Every
   * adapter added after W18 sets this.
   */
  shadow?: boolean;
}

/** Strips the container mount prefix from a tool-reported path. */
export function relativeTo(mountPath: string, file: string): string {
  const prefix = `${mountPath.replace(/\/$/, '')}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * Finds the first JSON value in a stream that may carry a preamble.
 *
 * Biome prints an "experimental reporter" warning to stdout BEFORE its JSON,
 * so a plain JSON.parse of the stream fails on a run that worked perfectly.
 * Rather than stripping that one message by name — which would break the day
 * they reword it — this finds where the JSON starts.
 */
export function extractJson(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  return start === -1 ? null : trimmed.slice(start);
}

/** Extensions present in a snapshot, for detect(). */
export function hasExtension(files: readonly string[], extensions: readonly string[]): boolean {
  return files.some((file) => extensions.some((ext) => file.endsWith(ext)));
}

/**
 * Every top-level JSON value in a stream, in order.
 *
 * The file-based adapters run their tool through `find -exec ... {} +`, which
 * batches files and so may start the tool more than once — each start prints
 * its own JSON document, and the stream is several documents back to back.
 * A single JSON.parse would fail on exactly the large repositories where the
 * findings matter most. Anything that is not JSON (a stray warning between
 * documents) is skipped rather than failing the whole stream.
 */
export function parseJsonStream(stdout: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < stdout.length) {
    const ch = stdout[i];
    if (ch !== '{' && ch !== '[') {
      i += 1;
      continue;
    }
    const end = matchingClose(stdout, i);
    // Unclosed: the stream was cut off (wall clock, output cap). Everything
    // after this opener is inside it, so there is nothing further to find —
    // and retrying from each later bracket would be quadratic on exactly the
    // large outputs that get truncated.
    if (end === -1) break;
    try {
      out.push(JSON.parse(stdout.slice(i, end + 1)));
      i = end + 1;
    } catch {
      // Balanced but not JSON — a bracket in prose. Step past the opener and
      // keep looking rather than losing every document after it.
      i += 1;
    }
  }
  return out;
}

/** Index of the bracket closing the one at `start`, string-aware; -1 if none. */
function matchingClose(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Directories no file-based adapter descends into — the same set the snapshot
 * file lister skips, so detect() and the command agree on what the tree is.
 */
export const PRUNED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.venv',
  '__pycache__',
];

/**
 * argv for "run TOOL over every file under ROOT whose basename matches".
 *
 * For tools that take files, not directories (shellcheck, hadolint). The file
 * list is found INSIDE the container rather than written into the argv: the
 * whole adapter section is one `sh -c` string, which Linux caps at 128 KiB,
 * and a repository with a few thousand scripts would overflow it and fail the
 * entire code-health run — complexity and duplication included. Verified
 * against busybox find on alpine 3.20 (the scan image's base): -prune,
 * parentheses and `-exec {} +` are all supported.
 */
export function findExec(
  root: string,
  namePatterns: readonly string[],
  tool: readonly string[],
): string[] {
  const prune = PRUNED_DIRS.flatMap((dir, i) => (i === 0 ? ['-name', dir] : ['-o', '-name', dir]));
  const names = namePatterns.flatMap((p, i) => (i === 0 ? ['-name', p] : ['-o', '-name', p]));
  return [
    'find',
    root,
    '(',
    ...prune,
    ')',
    '-prune',
    '-o',
    '-type',
    'f',
    '(',
    ...names,
    ')',
    '-exec',
    ...tool,
    '{}',
    '+',
  ];
}

/** Does a relative path's basename match a find(1)-style `*` pattern? */
export function basenameMatches(file: string, patterns: readonly string[]): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return patterns.some((pattern) => {
    const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    return re.test(base);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
