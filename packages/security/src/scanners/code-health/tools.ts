import { SCAN_MOUNT_PATH } from '../../../sandbox/profile.js';
import { runInSandbox, stderrTail } from '../../../sandbox/run.js';
import type { ScanBudget } from '../../framework/types.js';
import { resolveThresholds, verdictsForFunction, type CodeHealthThresholds } from './thresholds.js';
import { adaptersFor, listAdapters } from './adapters/registry.js';
import { dataStamp, shortHash } from '../../framework/data-stamp.js';
import { getScanner } from '../../registry.js';
import { DEFAULT_SCAN_IMAGE } from '../semgrep/scanner.js';
import type { AdapterContext, AdapterFinding, ToolAdapter } from './adapters/types.js';
import { listSnapshotFiles } from '../../adapters/architecture/tools.js';
import {
  isNonProductionPath,
  nonProductionFnmatchGlobs,
  nonProductionGlobstarGlobs,
} from '@repopulse/shared';

// code_health_tools (W9-02, CODE_HEALTH_SUITE.md §2/§10, FR-CH-2).
//
// Two tools, both admitted by the same filter: they PARSE SOURCE STANDALONE.
// lizard and jscpd read files and compute numbers — no dependency install, no
// network, nothing resolved at scan time. That is the whole reason they can run
// inside a --network=none sandbox over someone else's code, and it is the bar
// any future tool adapter has to clear (§10).

export const CODE_HEALTH_SCANNER_KEY = 'code_health_tools';

/** The pinned versions of the two tools this scanner runs itself (stamped on every run). */
export const CODE_HEALTH_TOOL_PINS = { lizard: '1.24.0', jscpd: '4.3.0' } as const;

/**
 * The data stamp of a code-health run (W23-09).
 *
 * The run's own `tool_versions` name only the adapters the TREE triggered, which
 * is known after the run. What the probe can know without a tree is everything
 * that could change what those adapters, lizard and jscpd report for the SAME
 * tree: the pins, the registered adapters and their versions (a NEW adapter may
 * apply to this tree and was never in the baseline's list), the thresholds, the
 * scan image the tools live in, the workspace's rule lifecycle state (adapter
 * findings pass through the shadow registry), and the in-process scanner version. The probe
 * then reuses the baseline's `tool_versions` — same tree, same stamp, same
 * adapters triggered — and this string is what guards the rest.
 */
export function codeHealthDataVersion(
  thresholds: Partial<CodeHealthThresholds> | undefined,
  /** The workspace's rule lifecycle state (`ruleStateStamp`); null = unreadable. */
  rules: string | null,
): string | null {
  return dataStamp({
    adapters: shortHash(
      listAdapters()
        .map((a) => `${a.key}@${a.version}`)
        .sort()
        .join(','),
    ),
    image: DEFAULT_SCAN_IMAGE,
    rules,
    pins: Object.entries(CODE_HEALTH_TOOL_PINS)
      .map(([k, v]) => `${k}${v}`)
      .join(','),
    scanner: getScanner(CODE_HEALTH_SCANNER_KEY)?.version,
    thresholds: shortHash(JSON.stringify(resolveThresholds(thresholds))),
  });
}

/**
 * Code-quality adapters whose findings follow the pertinent-code rule (W27-01):
 * a lint finding in a test, a fixture or vendored code is not reported. The IaC
 * adapters (checkov, hadolint, actionlint, shellcheck, iacrender) are not here:
 * a Dockerfile under `build/` is the one that ships, and their findings are
 * configuration risk rather than code quality.
 */
export const PATH_SCOPED_ADAPTERS: ReadonlySet<string> = new Set(['ruff', 'biome', 'cppcheck']);

/**
 * W27-01, "pertinent code only": true for a code-health finding this scanner no
 * longer reports because its file is not production code (tests, fixtures,
 * generated, vendored or built code). lizard and jscpd findings, and the
 * code-quality adapters'; never an IaC adapter's. The sweep uses the same
 * answer, so an old finding on such a file closes instead of lingering.
 */
export function isOutOfScopeCodeHealth(row: {
  ruleId?: string | null;
  file?: string | null;
}): boolean {
  if (!row.file || !isNonProductionPath(row.file)) return false;
  if (!row.ruleId) return false;
  if (!row.ruleId.startsWith('tool.')) return true;
  return PATH_SCOPED_ADAPTERS.has(row.ruleId.split('.')[1] ?? '');
}

/**
 * lizard's `-x` arguments: non-production paths are never read (W27-01). Only
 * shapes a glob states exactly; isNonProductionPath filters the rest after.
 */
export function lizardExcludeArgs(): string[] {
  return nonProductionFnmatchGlobs().flatMap((glob) => ['-x', glob]);
}

/** jscpd's `--ignore` value (comma-separated globs, verified against jscpd 4.3.0). */
export function jscpdIgnoreArg(): string {
  return nonProductionGlobstarGlobs().join(',');
}

/**
 * Clones that involve production code (W27-01). Both sides non-production:
 * dropped. One side production: kept, and stated from the production side, so
 * the finding sits on the file someone would change.
 */
export function pertinentClones(
  clones: readonly DuplicationReport['clones'][number][],
): DuplicationReport['clones'] {
  const kept: DuplicationReport['clones'] = [];
  for (const clone of clones) {
    const firstOut = isNonProductionPath(clone.file);
    const secondOut = isNonProductionPath(clone.duplicateFile);
    if (firstOut && secondOut) continue;
    if (!firstOut) {
      kept.push(clone);
      continue;
    }
    kept.push({
      file: clone.duplicateFile,
      startLine: clone.duplicateStartLine,
      endLine: clone.duplicateStartLine + Math.max(clone.lines, 1) - 1,
      duplicateFile: clone.file,
      duplicateStartLine: clone.startLine,
      lines: clone.lines,
    });
  }
  return kept;
}

/** Where jscpd writes its report — a tmpfs, because the root is read-only. */
const JSCPD_OUT = '/tmp/jscpd';

/**
 * W25-04: reduces jscpd's report to what parseJscpdReport reads (the total
 * percentage and each clone's two locations and length), dropping the clone
 * fragments and per-file statistics that made saleor's stdout overflow.
 * Run by node inside the scan container; argv[1] is the report path.
 */
export const JSCPD_PROJECT = [
  'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));',
  'const loc=(f,end)=>f?(end?{name:f.name,start:f.start,end:f.end}:{name:f.name,start:f.start}):undefined;',
  'process.stdout.write(JSON.stringify({',
  'statistics:{total:{percentage:r.statistics&&r.statistics.total?r.statistics.total.percentage:0}},',
  'duplicates:(r.duplicates||[]).map(d=>({firstFile:loc(d.firstFile,true),secondFile:loc(d.secondFile,false),lines:d.lines}))',
  '}));',
].join('');

/**
 * W25-04: the stdout cap for this scanner's one container. lizard's CSV is a
 * line per function and every adapter appends its own JSON, so a large Python
 * or TypeScript monorepo outgrows the sandbox's 32 MB default even with the
 * jscpd report reduced. 128 MB is under the runner protocol's 256 MB ceiling.
 */
export const CODE_HEALTH_MAX_STDOUT_BYTES = 128 * 1024 * 1024;

export interface LizardFunction {
  file: string;
  name: string;
  nloc: number;
  ccn: number;
  tokens: number;
  parameters: number;
  length: number;
  startLine: number;
  endLine: number;
}

/**
 * Parses `lizard --csv`.
 *
 * Column order verified by running the tool (1.24.0):
 * nloc, ccn, tokens, params, length, location, file, name, long_name, start, end
 */
export function parseLizardCsv(csv: string, rootPrefix = SCAN_MOUNT_PATH): LizardFunction[] {
  const out: LizardFunction[] = [];
  for (const line of csv.split('\n')) {
    if (line.trim() === '') continue;
    const cells = splitCsv(line);
    if (cells.length < 11) continue;
    const [nloc, ccn, tokens, params, length, , file, name, , start, end] = cells;
    const parsed = {
      nloc: Number(nloc),
      ccn: Number(ccn),
      tokens: Number(tokens),
      parameters: Number(params),
      length: Number(length),
      startLine: Number(start),
      endLine: Number(end),
    };
    // A row with a non-numeric metric is a header or a tool-format change, and
    // guessing at it would put NaN thresholds into findings.
    if (Object.values(parsed).some((v) => !Number.isFinite(v))) continue;
    out.push({
      file: stripPrefix(String(file), rootPrefix),
      name: String(name),
      ...parsed,
    });
  }
  return out;
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function stripPrefix(file: string, prefix: string): string {
  return file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : file;
}

export interface DuplicationReport {
  /** Percentage of duplicated lines across the scanned tree. */
  percentage: number;
  clones: {
    file: string;
    startLine: number;
    endLine: number;
    duplicateFile: string;
    duplicateStartLine: number;
    lines: number;
  }[];
}

/** Parses jscpd's JSON report (4.x shape, verified by running it). */
export function parseJscpdReport(json: string, rootPrefix = SCAN_MOUNT_PATH): DuplicationReport {
  const parsed = JSON.parse(json) as {
    statistics?: { total?: { percentage?: number } };
    duplicates?: {
      firstFile?: { name?: string; start?: number; end?: number };
      secondFile?: { name?: string; start?: number };
      lines?: number;
    }[];
  };

  return {
    percentage: Number(parsed.statistics?.total?.percentage ?? 0),
    clones: (parsed.duplicates ?? []).map((d) => ({
      file: stripPrefix(String(d.firstFile?.name ?? ''), rootPrefix),
      startLine: Number(d.firstFile?.start ?? 0),
      endLine: Number(d.firstFile?.end ?? 0),
      duplicateFile: stripPrefix(String(d.secondFile?.name ?? ''), rootPrefix),
      duplicateStartLine: Number(d.secondFile?.start ?? 0),
      lines: Number(d.lines ?? 0),
    })),
  };
}

export interface CodeHealthFinding {
  ruleId: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: number;
  title: string;
  message: string;
  measured: number;
  threshold: number;
}

export interface PostureMetrics {
  /** metric_snapshots keys, so trends ride the existing series endpoint. */
  ch_duplication_pct: number;
  ch_complexity_p90: number | null;
  ch_worst_fn_count: number;
}

export interface ToolRunResult {
  status: 'succeeded' | 'failed';
  findings: CodeHealthFinding[];
  metrics: PostureMetrics;
  toolVersions: Record<string, string>;
  /**
   * Findings from the §10 TOOL ADAPTERS (ruff, Biome), kept separate from our
   * own rule findings so the caller can dedupe them against the pack rules
   * before storing (W9-08 wiring).
   *
   * They were proven to run in the sandbox when the adapters landed and then
   * called by nothing — the scanner never invoked them, so no ruff or Biome
   * finding has ever reached the database.
   */
  adapterFindings: AdapterFinding[];
  /** Adapters that applied but whose output could not be read — never silent. */
  adapterErrors: { adapter: string; reason: string }[];
  error?: string;
}

export interface RunToolsArgs {
  targetDir: string;
  image: string;
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  thresholds?: Partial<CodeHealthThresholds>;
  runtime?: string;
  /** Test seam. Production uses the registry's language routing. */
  adapters?: readonly ToolAdapter[];
  /**
   * W23-03: do not run jscpd. Duplication is the one WHOLE-TREE half of this
   * scanner (a clone is a relation between files), so an incremental run over a
   * handful of changed files must not run it: it would report only the clones
   * among those files and read as "the rest are gone".
   */
  skipDuplication?: boolean;
}

/** argv -> a single-quoted shell word list, so no argument can be re-parsed. */
function shellQuote(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** Splits one stdout into our half plus one section per adapter, in order. */
export function splitSections(stdout: string, adapters: readonly ToolAdapter[]): string[] {
  let rest = stdout;
  const out: string[] = [];
  for (const adapter of adapters) {
    const marker = `===ADAPTER:${adapter.key}===`;
    const at = rest.indexOf(marker);
    if (at === -1) {
      // The marker is echoed unconditionally, so its absence means the shell
      // never got that far — truncated output, not an empty result.
      out.push(rest);
      rest = '';
      continue;
    }
    out.push(rest.slice(0, at));
    rest = rest.slice(at + marker.length);
  }
  out.push(rest);
  return out;
}

/** p90 of a numeric series, or null when there is nothing to rank. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/**
 * Runs both tools in ONE container.
 *
 * One run, not two: the snapshot is already mounted, both tools are in the same
 * image, and a second container start per scan doubles the cost of the thing
 * that is already the slow part.
 */
export async function runCodeHealthTools(args: RunToolsArgs): Promise<ToolRunResult> {
  const thresholds = resolveThresholds(args.thresholds);
  const emptyMetrics: PostureMetrics = {
    ch_duplication_pct: 0,
    ch_complexity_p90: null,
    ch_worst_fn_count: 0,
  };

  // Language routing is the ADAPTER's decision (§10), so the file list has to
  // be gathered before the container starts.
  const ctx: AdapterContext = {
    mountPath: SCAN_MOUNT_PATH,
    files: listSnapshotFiles(args.targetDir),
  };
  const adapters = args.adapters ?? adaptersFor(ctx);

  const result = await runInSandbox({
    image: args.image,
    snapshotDir: args.targetDir,
    ...(args.runtime ? { runtime: args.runtime } : {}),
    writablePaths: ['/opt/opengrep/.opengrep'],
    budget: args.budget,
    maxStdoutBytes: CODE_HEALTH_MAX_STDOUT_BYTES,
    parseOutput: false,
    command: [
      'sh',
      '-c',
      // Both outputs on one stdout, separated by a marker. jscpd insists on
      // writing its report to a directory, so it goes to the tmpfs and is cat'd
      // back — the alternative is a second mount for output, which would mean a
      // writable path pointing at the host.
      [
        // W27-01: tests, fixtures, generated, vendored and built code are not
        // measured (lizard -x, jscpd --ignore); the results are filtered by
        // isNonProductionPath again below, for the shapes a glob cannot state.
        `lizard --csv ${shellQuote(lizardExcludeArgs())} ${SCAN_MOUNT_PATH} 2>/dev/null || true`,
        `echo '===JSCPD==='`,
        ...(args.skipDuplication
          ? [`echo '{}'`]
          : [
              `jscpd --min-lines ${thresholds.minLines} --min-tokens ${thresholds.minTokens} ` +
                `--ignore ${shellQuote([jscpdIgnoreArg()])} ` +
                `--reporters json --output ${JSCPD_OUT} --silent ${SCAN_MOUNT_PATH} >/dev/null 2>&1 || true`,
              // W25-04: only the fields parseJscpdReport reads. jscpd's own
              // report carries every clone's source text and a per-file stats
              // table, and on saleor that pushed one stdout past the 32 MB
              // cap ("stdout cap exceeded", whole run failed). node is in the
              // scan image for jscpd itself; the plain cat stays as the
              // fallback so a missing node degrades to today's behaviour.
              `node -e ${shellQuote([JSCPD_PROJECT])} ${JSCPD_OUT}/jscpd-report.json 2>/dev/null || cat ${JSCPD_OUT}/jscpd-report.json 2>/dev/null || echo '{}'`,
            ]),
        // Each adapter appends its own section to the SAME stdout, behind its
        // own marker. Still one container: adding a start per tool would
        // multiply the slowest part of a scan by the number of adapters.
        // `|| true` because a linter exits non-zero when it finds something,
        // which is a successful run.
        ...adapters.flatMap((adapter) => [
          `echo '===ADAPTER:${adapter.key}==='`,
          `${shellQuote(adapter.command(ctx))} 2>/dev/null || true`,
        ]),
      ].join('; '),
    ],
  });

  const toolVersions: Record<string, string> = { ...CODE_HEALTH_TOOL_PINS };
  for (const adapter of adapters) toolVersions[adapter.key] = adapter.version;

  if (result.status !== 'succeeded' || result.rawStdout === undefined) {
    return {
      status: 'failed',
      findings: [],
      metrics: emptyMetrics,
      toolVersions,
      adapterFindings: [],
      adapterErrors: [],
      error: result.error ?? result.status,
    };
  }

  const [ourHalf = '', ...adapterSections] = splitSections(result.rawStdout, adapters);
  const [lizardCsv = '', jscpdJson = '{}'] = ourHalf.split('===JSCPD===');
  // W27-01 backstop: what the -x globs could not state (`test_*.py`, …).
  // Filtered before the metrics too: a p90 over test helpers is not the
  // complexity of the code that ships.
  const functions = parseLizardCsv(lizardCsv).filter((fn) => !isNonProductionPath(fn.file));

  const adapterFindings: AdapterFinding[] = [];
  const adapterErrors: ToolRunResult['adapterErrors'] = [];
  adapters.forEach((adapter, index) => {
    const section = adapterSections[index] ?? '';
    if (section.trim() === '') {
      // An adapter that applied and produced nothing at all is reported, not
      // read as a clean tree: "ruff found no problems" and "ruff did not run"
      // must never look the same.
      // The RUNTIME's words when the adapter never ran (W16-37) — a missing
      // scan image says so on stderr, and "produced no output" is the symptom.
      const detail = stderrTail(result.stderr, 2, 200);
      adapterErrors.push({
        adapter: adapter.key,
        reason: detail === '' ? 'produced no output' : `produced no output: ${detail}`,
      });
      return;
    }
    try {
      const parsed = adapter.parse(section, ctx);
      adapterFindings.push(
        ...parsed.filter((f) => !isOutOfScopeCodeHealth({ ruleId: f.ruleId, file: f.file })),
      );
    } catch (error) {
      adapterErrors.push({
        adapter: adapter.key,
        reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  });

  let duplication: DuplicationReport = { percentage: 0, clones: [] };
  try {
    duplication = parseJscpdReport(jscpdJson.trim() || '{}');
  } catch {
    // A malformed duplication report is reported as zero clones AND the
    // percentage stays 0 — but the run is not failed, because the complexity
    // half is still valid. Losing both because one parser choked would be
    // worse than saying what we have.
    duplication = { percentage: 0, clones: [] };
  }

  const findings: CodeHealthFinding[] = [];

  for (const fn of functions) {
    for (const verdict of verdictsForFunction(fn, thresholds)) {
      findings.push({
        ruleId: verdict.rule,
        file: fn.file,
        lineStart: fn.startLine,
        lineEnd: fn.endLine,
        severity: verdict.severity,
        title: `${verdict.rule}: ${fn.name}`,
        message: verdict.message,
        measured: verdict.measured,
        threshold: verdict.threshold,
      });
    }
  }

  // File length is a per-FILE fact, so it is summed from the functions' own
  // end lines rather than re-read: the tool already walked the file, and a
  // second read would be a second answer to the same question.
  const fileEnds = new Map<string, number>();
  for (const fn of functions) {
    fileEnds.set(fn.file, Math.max(fileEnds.get(fn.file) ?? 0, fn.endLine));
  }
  for (const [file, lines] of fileEnds) {
    if (lines > thresholds.fileLines) {
      findings.push({
        ruleId: 'complexity.file_length',
        file,
        lineStart: 1,
        lineEnd: lines,
        severity: 1,
        title: `complexity.file_length: ${file}`,
        message: `File is at least ${lines} lines, over ${thresholds.fileLines}. Long files are where things go to be forgotten.`,
        measured: lines,
        threshold: thresholds.fileLines,
      });
    }
  }

  for (const clone of pertinentClones(duplication.clones)) {
    findings.push({
      ruleId: 'duplication.clone',
      file: clone.file,
      lineStart: clone.startLine,
      lineEnd: clone.endLine,
      severity: 2,
      title: `duplication.clone: ${clone.file}`,
      message: `${clone.lines} duplicated lines, also at ${clone.duplicateFile}:${clone.duplicateStartLine}. A copy is a fix that only lands in one place.`,
      measured: clone.lines,
      threshold: thresholds.minLines,
    });
  }

  return {
    status: 'succeeded',
    findings,
    adapterFindings,
    adapterErrors,
    metrics: {
      ch_duplication_pct: duplication.percentage,
      // null when the tree has no functions at all — a p90 over an empty set
      // is not 0, and a 0 here would draw a flat healthy line on the trend.
      ch_complexity_p90: percentile(
        functions.map((f) => f.ccn),
        90,
      ),
      ch_worst_fn_count: functions.filter((f) => f.ccn > thresholds.complexityCritical).length,
    },
    toolVersions,
  };
}
