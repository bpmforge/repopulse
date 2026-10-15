import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingFinding } from '@repopulse/insights';
import { SCAN_MOUNT_PATH } from '../../../sandbox/profile.js';
import { runInSandbox, stderrTail } from '../../../sandbox/run.js';
import { rulepackMountDir } from '../../../sandbox/tooling.js';
import type { ScanBudget } from '../../framework/types.js';
import { parseOpengrepOutput, type SemgrepFinding } from './output.js';

// The semgrep scanner (W8-07, SECURITY_SUITE.md §3.3, FR-SEC-6).
//
// The engine is OPENGREP (LGPL), and the rules are OURS. Semgrep's registry
// packs (`p/*`, `--config auto`) are barred for service use by licence
// (CPU_FIRST_OFFLOAD 2026-07-16 §4/§6) — so this scanner never accepts a
// registry config, and refuses one loudly rather than quietly ignoring it: a
// silently dropped `--config auto` would mean a customer thinks they are
// running a 2,000-rule pack and is running six.

export const SEMGREP_SCANNER_KEY = 'semgrep';

/** Where the tool writes inside the sandbox — see Containerfile.scan. */
export const OPENGREP_WRITABLE_PATHS = ['/opt/opengrep/.opengrep'];

/** The semgrep pack dir. Named apart from the secrets pack's own constant. */
export const SEMGREP_RULEPACK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../rulepacks/semgrep',
);

/** Mount point of the rulepack inside the sandbox. */
export const RULES_MOUNT_PATH = '/rules';

export class RegistryRulesRefusedError extends Error {
  constructor(config: string) {
    super(
      `refusing rulepack config "${config}": Semgrep registry rules are licence-barred for ` +
        'service use (SECURITY_SUITE §3.3). Point this at an in-house pack.',
    );
    this.name = 'RegistryRulesRefusedError';
  }
}

/** `p/...`, `r/...` and `auto` are Semgrep registry references. */
export function assertNotRegistryConfig(config: string): void {
  if (/^(p|r)\//.test(config) || config === 'auto' || config.includes('semgrep.dev')) {
    throw new RegistryRulesRefusedError(config);
  }
}

export interface RulepackInfo {
  dir: string;
  files: string[];
  ruleIds: string[];
  /** Stamped onto every scan_run: a finding is only reproducible with it. */
  version: string;
}

/**
 * Reads the shipped pack's rule ids straight out of the YAML.
 *
 * A line-level read rather than a YAML parse, deliberately: the ids are only
 * needed to un-prefix Opengrep's check_ids, and adding a YAML dependency to
 * do it would put a parser between us and a file the ENGINE is the real reader
 * of. If a rule id here is missed, the id falls back to the last dot-segment —
 * degraded, not wrong.
 */
export function readRulepack(dir: string = SEMGREP_RULEPACK_DIR): RulepackInfo {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const ruleIds: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      const match = /^\s*-?\s*id:\s*(\S+)\s*$/.exec(line);
      if (match?.[1]) ruleIds.push(match[1]);
    }
  }
  // The version is the pack's file names, not a hand-maintained number: a
  // number gets forgotten on the edit that matters.
  return { dir, files, ruleIds, version: files.join(',') };
}

export interface SemgrepRunArgs {
  /** Directory to scan — a W8-03 snapshot, or a scratch dir of changed files. */
  targetDir: string;
  budget: Pick<ScanBudget, 'wallClockMs'> & Partial<ScanBudget>;
  image?: string;
  rulepackDir?: string;
  /** Repo-configured pack reference, validated against the licence rule. */
  configRef?: string;
  runtime?: string;
}

export interface SemgrepRunResult {
  status: 'succeeded' | 'failed' | 'timed_out' | 'invalid_output';
  findings: SemgrepFinding[];
  toolErrors: string[];
  durationMs: number;
  error?: string;
  /** Stamped into scan_runs.tool_versions. */
  toolVersions: Record<string, string>;
}

export const DEFAULT_SCAN_IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';

/** Opengrep's own version, read from the image rather than assumed. */
export function imageToolVersion(image: string, runtime = 'podman'): string {
  try {
    return execFileSync(
      runtime,
      ['run', '--rm', '--network=none', image, 'opengrep', '--version'],
      {
        stdio: 'pipe',
      },
    )
      .toString()
      .trim();
  } catch {
    // Unknown is honest; a hard-coded fallback would stamp a version onto
    // findings that were produced by a different binary.
    return 'unknown';
  }
}

/**
 * Runs Opengrep over `targetDir` inside the §2.2 sandbox.
 *
 * The rulepack is a SECOND read-only mount rather than something the container
 * fetches: the container has `--network=none`, which is the whole point, so
 * anything it needs arrives as a mount (deploy/scan-db-sync.sh does the same
 * job in production).
 */
export async function runSemgrepScan(args: SemgrepRunArgs): Promise<SemgrepRunResult> {
  if (args.configRef) assertNotRegistryConfig(args.configRef);

  // Read from and mounted from the directory the RUNTIME can reach: the
  // checkout on a dev machine, the synced copy under SCAN_RULES_DIR behind a
  // scan-runner (W17-27, sandbox/tooling.ts). The code-health packs come
  // through here too (logging, perf), so one resolution covers all three.
  const rulepack = readRulepack(rulepackMountDir(args.rulepackDir ?? SEMGREP_RULEPACK_DIR));
  const image = args.image ?? DEFAULT_SCAN_IMAGE;
  const started = Date.now();

  const result = await runInSandbox({
    image,
    snapshotDir: args.targetDir,
    ...(args.runtime ? { runtime: args.runtime } : {}),
    extraMounts: [{ hostPath: rulepack.dir, containerPath: RULES_MOUNT_PATH }],
    writablePaths: OPENGREP_WRITABLE_PATHS,
    budget: args.budget,
    // Opengrep speaks its own JSON, so the sandbox hands the bytes back and
    // output.ts validates them — the schema check still happens, one layer out.
    parseOutput: false,
    command: [
      'opengrep',
      'scan',
      '--json',
      '--quiet',
      // Every pack file by name. `--config /rules` would also work today and
      // would silently pick up anything a future mount put there.
      ...rulepack.files.flatMap((f) => ['--config', `${RULES_MOUNT_PATH}/${f}`]),
      SCAN_MOUNT_PATH,
    ],
  });

  const toolVersions = {
    opengrep: imageToolVersion(image, args.runtime ?? 'podman'),
    rulepack: rulepack.version,
  };

  if (result.status !== 'succeeded' && result.rawStdout === undefined) {
    return {
      status: result.status === 'timed_out' ? 'timed_out' : 'failed',
      findings: [],
      toolErrors: [],
      durationMs: Date.now() - started,
      ...(result.error ? { error: result.error } : {}),
      toolVersions,
    };
  }

  const parsed = parseOpengrepOutput({
    stdout: result.rawStdout ?? '',
    knownRuleIds: rulepack.ruleIds,
    rootDir: SCAN_MOUNT_PATH,
  });

  if (!parsed.ok) {
    // THE RUNTIME'S OWN WORDS, when there are any (W16-37).
    //
    // "opengrep produced no output" is what a reader saw when the SCAN IMAGE
    // was missing — accurate, and it describes the symptom rather than the
    // cause, which podman had already written to stderr. Opengrep itself
    // reports its errors inside the JSON (`errors[]`, carried as toolErrors),
    // so this appends only for the case where nothing ran at all.
    //
    // Read from the END and capped: a runtime that logged before failing
    // buries its reason at the bottom, and this lands in a row a screen shows.
    const detail = stderrTail(result.stderr);
    return {
      status: 'invalid_output',
      findings: [],
      toolErrors: [],
      durationMs: Date.now() - started,
      error: detail === '' ? parsed.error : `${parsed.error}: ${detail}`,
      toolVersions,
    };
  }

  return {
    status: 'succeeded',
    findings: parsed.findings,
    toolErrors: parsed.toolErrors,
    durationMs: Date.now() - started,
    toolVersions,
  };
}

/** Turns tool output into storable findings (FR-INSIGHTS-1 lifecycle). */
export function toIncomingFindings(findings: readonly SemgrepFinding[]): IncomingFinding[] {
  return findings.map((f) => ({
    dimension: 'sast',
    severity: f.severity,
    // 3, not 5: a pattern match is a shape, and the reviewer's REAL/FP call is
    // what moves it. Claiming high confidence for an unreviewed static match is
    // how a triage queue becomes something people stop reading.
    confidence: 3,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    title: f.title,
    evidenceQuote: `${f.file}:${f.lineStart} — ${f.ruleId}`,
    rationale: f.message,
    suggestedFix: null,
    scannerKey: SEMGREP_SCANNER_KEY,
    ruleId: f.ruleId,
    yields: f.yields.length > 0 ? Object.fromEntries(f.yields.map((y) => [y, true])) : null,
  }));
}

/** Files a diff-scoped run should scan, filtered to what the pack can read. */
export function scannableFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(js|jsx|ts|tsx|mjs|cjs|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}
