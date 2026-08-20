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
  /** Which of our dimensions this belongs in. */
  dimension: 'code_health' | 'correctness';
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
