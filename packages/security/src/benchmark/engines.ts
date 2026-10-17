import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { docstringInflation, ldrFindings } from '../scanners/anti-slop/ldr.js';
import { UNUSED_EXPORT_RULE_ID, unusedExports } from '../scanners/anti-slop/unused-exports.js';
import {
  PHANTOM_MODULE_RULE_ID,
  PHANTOM_SYMBOL_RULE_ID,
  phantomRefs,
} from '../scanners/anti-slop/phantom-refs.js';
import { runCodeHealthTools } from '../scanners/code-health/tools.js';
import { scanPatch } from '../scanners/secrets/detect.js';
import { loadRulepack } from '../scanners/secrets/rulepack.js';
import { parseOpengrepOutput } from '../scanners/semgrep/output.js';
import { readRulepack, SEMGREP_RULEPACK_DIR } from '../scanners/semgrep/scanner.js';
import { treeFiles, type Tree } from './corpus.js';
import type { BenchFinding } from './match.js';

// The deterministic layers the benchmark replays (W18-17).
//
// FAST LANE: the in-process checks, called exactly as the scanners call them —
// the anti_slop deterministic layer (anti-slop/run.ts) and the secrets
// rulepack (secrets/detect.ts). Shadow status is deliberately ignored: the
// benchmark is the evidence a promotion is argued from, so it has to measure
// rules before they are active.
//
// YAML PACKS: every pack directory the product mounts, run by whichever of
// opengrep or semgrep is on this machine. Rule files are named one by one, as
// scanner.ts does, so a stray file elsewhere cannot join the run.

export const FAST_LANE_SLOP_RULES = [
  'slop.low_logic_density',
  'slop.docstring_inflation',
  UNUSED_EXPORT_RULE_ID,
  PHANTOM_SYMBOL_RULE_ID,
  PHANTOM_MODULE_RULE_ID,
] as const;

export function fastLaneRules(): Map<string, string> {
  const rules = new Map<string, string>(FAST_LANE_SLOP_RULES.map((r) => [r, 'slop']));
  for (const rule of loadRulepack().rules) rules.set(rule.id, 'secrets');
  return rules;
}

/** Files read as text. A NUL byte means binary, which no fast-lane check reads. */
function readSources(tree: Tree): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const rel of treeFiles(tree.dir)) {
    const source = readFileSync(path.join(tree.dir, rel), 'utf8');
    if (source.includes('\0')) continue;
    out.push({ path: rel, source });
  }
  return out;
}

/** A unified diff that adds the whole file — how a first commit reaches the secrets scanner. */
export function wholeFilePatch(source: string): string {
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

export function runFastLane(tree: Tree): BenchFinding[] {
  const sources = readSources(tree);
  const out: BenchFinding[] = [];
  const push = (
    ruleId: string,
    dimension: string,
    file: string,
    lineStart: number,
    lineEnd = lineStart,
  ) =>
    out.push({
      suite: tree.suite,
      tree: tree.id,
      file,
      lineStart,
      lineEnd,
      ruleId,
      dimension,
      cwe: null,
    });

  // Line 1 for the two file-level measures, as anti-slop/run.ts stores them.
  for (const f of ldrFindings(sources)) push(f.ruleId, 'slop', f.file, 1);
  for (const s of sources) {
    for (const f of docstringInflation(s.path, s.source)) push(f.ruleId, 'slop', f.file, 1);
  }
  for (const f of unusedExports(sources)) push(f.ruleId, 'slop', f.file, f.line);
  // complete: true — the corpus tree is read whole, with no cap to hit.
  for (const f of phantomRefs(sources, { complete: true })) push(f.ruleId, 'slop', f.file, f.line);

  const pack = loadRulepack();
  for (const s of sources) {
    for (const m of scanPatch(s.path, wholeFilePatch(s.source), { rulepack: pack })) {
      push(m.ruleId, 'secrets', m.file, m.line);
    }
  }
  return out;
}

/** The pack directories the product's scanners mount, and the dimension each reports under. */
export interface PackDir {
  dir: string;
  dimensionOf: (ruleId: string) => string;
}

export const PACK_DIRS: readonly PackDir[] = [
  { dir: SEMGREP_RULEPACK_DIR, dimensionOf: () => 'sast' },
  {
    dir: path.resolve(SEMGREP_RULEPACK_DIR, '../code-health'),
    // One directory, two scanners: logging_hygiene keeps bpm-log-*, anti_slop
    // owns the rest (logging/run.ts).
    dimensionOf: (id) => (id.startsWith('bpm-log-') ? 'logging' : 'slop'),
  },
  {
    dir: path.resolve(SEMGREP_RULEPACK_DIR, '../code-health/perf'),
    dimensionOf: () => 'performance',
  },
];

export interface YamlPacks {
  files: string[];
  /** rule id → dimension */
  rules: Map<string, string>;
}

export function yamlPacks(): YamlPacks {
  const files: string[] = [];
  const rules = new Map<string, string>();
  for (const pack of PACK_DIRS) {
    const info = readRulepack(pack.dir);
    files.push(...info.files.map((f) => path.join(pack.dir, f)));
    for (const id of info.ruleIds) rules.set(id, pack.dimensionOf(id));
  }
  return { files, rules };
}

export interface YamlTool {
  bin: string;
  name: 'opengrep' | 'semgrep';
  version: string;
}

/** opengrep first (what production runs), then semgrep. Null = neither is installed. */
export function findYamlTool(override?: string): YamlTool | null {
  const candidates = override ? [override] : ['opengrep', 'semgrep'];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', env: quietEnv() });
    if (probe.status !== 0) continue;
    const name = path.basename(bin).startsWith('opengrep') ? 'opengrep' : 'semgrep';
    return { bin, name, version: probe.stdout.trim().split('\n').at(-1) ?? 'unknown' };
  }
  return null;
}

function quietEnv(): NodeJS.ProcessEnv {
  // No version check, no metrics: the run must not reach the network.
  // UTF-8: the packs contain non-ASCII, and the engine's Python layer dies
  // silently (exit 2, empty stdout) under a bare C locale.
  return {
    ...process.env,
    SEMGREP_ENABLE_VERSION_CHECK: '0',
    SEMGREP_SEND_METRICS: 'off',
    PYTHONUTF8: '1',
    LC_ALL: 'en_US.UTF-8',
  };
}

function parseCwe(cwe: string | null): number | null {
  const m = cwe ? /CWE-(\d+)/.exec(cwe) : null;
  return m ? Number(m[1]) : null;
}

export interface YamlRun {
  findings: BenchFinding[];
  /** Files the engine could not parse, relative to their tree. */
  errors: string[];
}

/**
 * Every tree in one engine invocation.
 *
 * The trees are COPIED into a scratch directory first. Run in place, the
 * engine would honour this repository's .gitignore (which hides the fetched
 * OWASP cache) and see paths that start `packages/security/fixtures/`, which
 * the product never does — a snapshot is the repository's root.
 */
export function runYamlPacks(tool: YamlTool, trees: readonly Tree[], packs: YamlPacks): YamlRun {
  const scratch = mkdtempSync(path.join(tmpdir(), 'rp-bench-'));
  try {
    const roots = trees.map((t, i) => {
      const rel = `t${String(i).padStart(3, '0')}`;
      cpSync(t.dir, path.join(scratch, rel), {
        recursive: true,
        filter: (src) => !path.basename(src).startsWith('.') || src === t.dir,
      });
      return { rel, tree: t };
    });
    const args = [
      'scan',
      '--json',
      '--quiet',
      ...(tool.name === 'semgrep' ? ['--metrics=off', '--disable-version-check'] : []),
      // The same engine setting the scanner passes, so the numbers describe the
      // product. Opengrep only: semgrep's OSS engine has no such flag.
      ...(tool.name === 'opengrep' ? ['--taint-intrafile'] : []),
      ...packs.files.flatMap((f) => ['--config', f]),
      scratch,
    ];
    const proc = spawnSync(tool.bin, args, {
      encoding: 'utf8',
      env: quietEnv(),
      maxBuffer: 256 * 1024 * 1024,
    });
    const parsed = parseOpengrepOutput({
      stdout: proc.stdout ?? '',
      knownRuleIds: [...packs.rules.keys()],
      rootDir: scratch,
    });
    if (!parsed.ok) throw new Error(`${tool.name} failed: ${parsed.error} ${proc.stderr ?? ''}`);

    const locate = (file: string) => {
      const [rel, ...rest] = file.split('/');
      const root = roots.find((r) => r.rel === rel);
      return root ? { tree: root.tree, file: rest.join('/') } : null;
    };
    const findings: BenchFinding[] = [];
    for (const f of parsed.findings) {
      const where = locate(f.file);
      if (!where) continue;
      findings.push({
        suite: where.tree.suite,
        tree: where.tree.id,
        file: where.file,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        ruleId: f.ruleId,
        dimension: packs.rules.get(f.ruleId) ?? 'sast',
        cwe: parseCwe(f.cwe),
      });
    }
    // Per-file errors (a snippet the parser rejected) are named, not counted:
    // a file the engine never read scores as clean, and the report has to say
    // which files those were. output.ts keeps only the messages, so the paths
    // come from the raw JSON.
    const raw = JSON.parse(proc.stdout) as { errors?: { path?: string }[] };
    const errors = (raw.errors ?? []).map((e) => {
      const rel = e.path?.startsWith(`${scratch}/`) ? e.path.slice(scratch.length + 1) : null;
      const where = rel ? locate(rel) : null;
      return where
        ? `${where.tree.suite}/${where.tree.id}/${where.file}`
        : 'engine error (no file)';
    });
    if (parsed.toolErrors.length !== errors.length) errors.push('engine error (no file)');
    return { findings, errors: [...new Set(errors)].sort() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- The tool adapters (W18-48) ---------------------------------------------
//
// checkov, actionlint, hadolint and shellcheck run only inside the scan image,
// so the benchmark reaches them the way the product does: through
// runCodeHealthTools over the tree, in the sandbox, and reads
// `adapterFindings`. What is scored is each tool's own rule, raw — before the
// cross-tool dedupe that decides which of two tools' reports of one defect is
// stored — because per-rule precision is a statement about the rule.

/** The adapters this lane scores; others in the registry (ruff, Biome, cppcheck) have their own suites. */
export const ADAPTER_TOOLS = ['checkov', 'actionlint', 'hadolint', 'shellcheck'] as const;

export interface AdapterRun {
  findings: BenchFinding[];
  /** Tool key -> the version its adapter was written against. */
  tools: Record<string, string>;
  /** Trees that were run, for the report's denominator. */
  trees: number;
}

export interface AdapterLaneOptions {
  /** A scan image reference (`localhost/repopulse/scan:dev`). */
  image: string;
  runtime?: string;
}

const toolOf = (ruleId: string): string => ruleId.split('.')[1] ?? '';

/**
 * Runs the adapters over the given trees in the scan image.
 *
 * A tree that fails to scan, or an adapter that errors, throws: a benchmark
 * that published numbers from a run where a tool crashed would score its
 * silence as precision.
 */
export async function runAdapterLane(
  trees: readonly Tree[],
  opts: AdapterLaneOptions,
): Promise<AdapterRun> {
  const findings: BenchFinding[] = [];
  const tools: Record<string, string> = {};
  for (const tree of trees) {
    const result = await runCodeHealthTools({
      targetDir: tree.dir,
      image: opts.image,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      budget: { wallClockMs: 300_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 },
    });
    if (result.status !== 'succeeded') {
      throw new Error(
        `adapter lane: ${tree.suite}/${tree.id} did not scan (${result.error ?? result.status})`,
      );
    }
    if (result.adapterErrors.length > 0) {
      const what = result.adapterErrors.map((e) => `${e.adapter}: ${e.reason}`).join('; ');
      throw new Error(`adapter lane: ${tree.suite}/${tree.id}: ${what}`);
    }
    for (const key of ADAPTER_TOOLS) {
      const version = result.toolVersions[key];
      if (version !== undefined) tools[key] = version;
    }
    for (const f of result.adapterFindings) {
      if (!(ADAPTER_TOOLS as readonly string[]).includes(toolOf(f.ruleId))) continue;
      findings.push({
        suite: tree.suite,
        tree: tree.id,
        file: f.file,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        ruleId: f.ruleId,
        dimension: f.dimension,
        cwe: null,
      });
    }
  }
  return { findings, tools, trees: trees.length };
}
