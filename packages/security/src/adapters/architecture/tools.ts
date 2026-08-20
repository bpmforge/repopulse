import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runInSandbox } from '../../../sandbox/run.js';
import type { ScanBudget } from '../../framework/types.js';
import type { AdapterContext } from '../../scanners/code-health/adapters/types.js';
import { ARCHITECTURE_ADAPTERS, type GraphAdapter } from './adapters.js';
import { detectArchitecture, type ArchitectureFinding, type ImportGraph } from './graph.js';
import { loadArchitecturePack, type ArchitecturePack } from './pack.js';

// Running the architecture adapters (W10-03, FR-REG-5).
//
// One container per adapter, each with the same `--network=none` profile
// everything else in this package uses. Nothing here loosens the sandbox: both
// tools were chosen because they run inside it as it already is.

export const ARCHITECTURE_SCANNER_KEY = 'architecture_register';

const MOUNT = '/scan';
const MAX_FILES = 20_000;

export interface RunArchitectureArgs {
  targetDir: string;
  image: string;
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  runtime?: string;
  pack?: ArchitecturePack;
  adapters?: readonly GraphAdapter[];
}

export interface ArchitectureToolResult {
  status: 'succeeded' | 'failed' | 'skipped';
  findings: ArchitectureFinding[];
  /** Adapter key -> version, stamped onto the scan_run (acceptance item 1). */
  toolVersions: Record<string, string>;
  /** Adapters that did not apply, and the ones that failed — both reported. */
  notApplicable: string[];
  toolErrors: { adapter: string; reason: string }[];
  /** Detections that could not run (too few modules), with their reason. */
  notRun: { ruleId: string; reason: string }[];
  moduleCount: number;
  error?: string;
}

/** Repo-relative file list for the adapters' detect()/command(). */
export function listSnapshotFiles(root: string, limit = MAX_FILES): string[] {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', '__pycache__']);
  const out: string[] = [];

  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (skip.has(entry)) continue;
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };

  walk(root);
  return out;
}

/** Merges per-language graphs. Module ids are language-native and disjoint. */
function mergeGraphs(graphs: readonly ImportGraph[]): ImportGraph {
  const merged: ImportGraph = { edges: new Map(), files: new Map() };
  for (const graph of graphs) {
    for (const [node, targets] of graph.edges) merged.edges.set(node, targets);
    for (const [node, file] of graph.files) merged.files.set(node, file);
  }
  return merged;
}

export async function runArchitectureTools(
  args: RunArchitectureArgs,
): Promise<ArchitectureToolResult> {
  const pack = args.pack ?? loadArchitecturePack();
  const adapters = args.adapters ?? ARCHITECTURE_ADAPTERS;
  const files = listSnapshotFiles(args.targetDir);
  const ctx: AdapterContext = { mountPath: MOUNT, files };

  const toolVersions: Record<string, string> = {};
  const notApplicable: string[] = [];
  const toolErrors: ArchitectureToolResult['toolErrors'] = [];
  const graphs: ImportGraph[] = [];

  for (const adapter of adapters) {
    if (!adapter.detect(ctx)) {
      notApplicable.push(adapter.key);
      continue;
    }
    toolVersions[adapter.key] = adapter.version;

    const result = await runInSandbox({
      image: args.image,
      snapshotDir: args.targetDir,
      ...(args.runtime ? { runtime: args.runtime } : {}),
      writablePaths: ['/opt/opengrep/.opengrep'],
      budget: args.budget,
      parseOutput: false,
      command: adapter.command(ctx),
    });

    if (result.status !== 'succeeded' || result.rawStdout === undefined) {
      // A tool that failed is NOT a clean repository. Recorded per adapter so
      // a Python-only failure does not silently discard the JS graph too.
      toolErrors.push({
        adapter: adapter.key,
        reason: result.error ?? `${result.status}${result.stderr ? `: ${result.stderr.slice(0, 200)}` : ''}`,
      });
      continue;
    }

    const parsed = adapter.parse(result.rawStdout, ctx);
    graphs.push(parsed.graph);
    for (const reason of parsed.skipped.slice(0, 20)) {
      toolErrors.push({ adapter: adapter.key, reason });
    }
  }

  if (Object.keys(toolVersions).length === 0) {
    return {
      status: 'skipped',
      findings: [],
      toolVersions,
      notApplicable,
      toolErrors,
      notRun: [],
      moduleCount: 0,
    };
  }

  const detection = detectArchitecture(mergeGraphs(graphs), pack);
  // EVERY adapter failing is a failed scan, not an empty one: reporting "no
  // architecture problems" because both tools crashed is the failure mode this
  // whole package is written against.
  const allFailed = graphs.length === 0;

  return {
    status: allFailed ? 'failed' : 'succeeded',
    findings: detection.findings,
    toolVersions,
    notApplicable,
    toolErrors,
    notRun: detection.notRun,
    moduleCount: detection.moduleCount,
    ...(allFailed ? { error: toolErrors.map((e) => `${e.adapter}: ${e.reason}`).join('; ') } : {}),
  };
}
