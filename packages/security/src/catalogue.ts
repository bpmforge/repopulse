import { registerScanner } from './registry.js';
import type { Scanner, ScannerContext, ScannerFinding } from './framework/types.js';
import { SECRETS_SCANNER_KEY } from './scanners/secrets/scanner.js';
import { SEMGREP_SCANNER_KEY } from './scanners/semgrep/scanner.js';
import { DEPENDENCY_SCANNER_KEY } from './scanners/dependency/findings.js';
import { CODE_HEALTH_SCANNER_KEY } from './scanners/code-health/tools.js';
import { ANTI_SLOP_SCANNER_KEY } from './scanners/anti-slop/run.js';
import { LOGGING_SCANNER_KEY } from './scanners/logging/run.js';
import { PERF_SCANNER_KEY } from './scanners/perf/run.js';
import { CHAINER_SCANNER_KEY } from './scanners/chainer/run.js';
import { ARCHITECTURE_SCANNER_KEY } from './adapters/architecture/tools.js';
import { SUPPLY_CHAIN_REGISTER_KEY } from './registers/run.js';
import { DRAFT_PASS_KEY } from './rules/draft-run.js';

// The built-in scanner catalogue (W16-28).
//
// registry.ts has said since W8-01 that "adding a scanner is one import and one
// array entry" — and that array was never written. registerScanner() had no
// caller outside its own test, so listScanners() returned [] in every process:
// every scanner rendered "(not installed)" on every install, getScanner() was
// always undefined, and every scan_run recorded scannerVersion "unregistered".
// A wave of shipped, tested security and code-health work was connected to
// nothing a user could see. This file is that array entry.
//
// WHAT A REGISTRATION CLAIMS. A row here says the scanner EXISTS in this build
// and names what it needs — it is a catalogue, not a promise that any keypress
// reaches it. What actually runs a scanner is the runner map the worker
// injects, and `triggers` is where the two are kept honest: a scanner only
// lists 'manual' when a runner is wired for it, and the manual-run route
// enqueues nothing else. Registering a scanner the button cannot reach would
// invert W16-20's bug — an absence that read as a measurement, replaced by a
// presence that reads as a capability.

/**
 * Every scanner here sweeps the warehouse for a repository; none of them scans
 * a single pinned SHA through a ScannerContext, and nothing in the product
 * enqueues a `sha`-mode job. So `run()` is unreachable, and says so rather than
 * pretending: a stub returning `[]` would report a clean repository.
 */
function sweepOnly(key: string) {
  return async (_ctx: ScannerContext): Promise<ScannerFinding[]> => {
    throw new Error(
      `"${key}" is a sweep scanner: it runs over a repository's warehoused history ` +
        'through the worker\'s runner map, not against one pinned commit. ' +
        'Enqueue it with mode "history" or "weekly".',
    );
  };
}

function sweeper(
  s: Omit<Scanner, 'run'>,
): Scanner {
  return { ...s, run: sweepOnly(s.key) };
}

/**
 * The scanners this build ships.
 *
 * Versions follow the `key.vN` shape the run modules already stamp onto
 * findings (`chainer.v1`, `perf.v1`, `supply_chain.v1`). They mark the
 * CATALOGUE entry; a finding still carries the tool versions its own run
 * resolved, which is the number that makes a result reproducible.
 */
export const BUILTIN_SCANNERS: readonly Scanner[] = [
  sweeper({
    key: SECRETS_SCANNER_KEY,
    displayName: 'Secrets',
    version: 'secrets.v1',
    inputs: 'diff',
    // The only scanner that can meet "a finding within 60s of the webhook":
    // it reads diff patches as they are ingested, no snapshot, no container.
    triggers: ['pr_synced', 'push', 'schedule', 'manual'],
  }),
  sweeper({
    key: SEMGREP_SCANNER_KEY,
    displayName: 'Semgrep (Opengrep, in-house rules)',
    version: 'semgrep.v1',
    inputs: 'snapshot',
    triggers: ['schedule', 'manual'],
    requiredTools: ['opengrep@1'],
  }),
  sweeper({
    key: CODE_HEALTH_SCANNER_KEY,
    displayName: 'Code health (complexity, duplication)',
    version: 'code_health.v1',
    inputs: 'snapshot',
    triggers: ['schedule', 'manual'],
    requiredTools: ['lizard@1', 'jscpd@4'],
  }),
  sweeper({
    key: ANTI_SLOP_SCANNER_KEY,
    displayName: 'Anti-slop',
    version: 'anti_slop.v1',
    inputs: 'snapshot',
    triggers: ['schedule', 'manual'],
  }),
  sweeper({
    key: CHAINER_SCANNER_KEY,
    displayName: 'Attack chainer',
    version: 'chainer.v1',
    inputs: 'findings',
    triggers: ['schedule', 'manual'],
  }),
  sweeper({
    key: SUPPLY_CHAIN_REGISTER_KEY,
    displayName: 'Supply chain register',
    version: 'supply_chain.v1',
    inputs: 'manifests',
    triggers: ['schedule', 'manual'],
  }),
  sweeper({
    key: ARCHITECTURE_SCANNER_KEY,
    displayName: 'Architecture register',
    version: 'architecture.v1',
    inputs: 'snapshot',
    triggers: ['schedule', 'manual'],
  }),
  sweeper({
    key: 'test_gap_register',
    displayName: 'Test gap register',
    version: 'test_gap.v1',
    inputs: 'findings',
    triggers: ['schedule', 'manual'],
  }),
  sweeper({
    key: 'knowledge_register',
    displayName: 'Knowledge register',
    version: 'knowledge.v1',
    inputs: 'findings',
    triggers: ['schedule', 'manual'],
  }),
  sweeper({
    key: DRAFT_PASS_KEY,
    displayName: 'Rule draft pass',
    version: 'rule_draft.v1',
    inputs: 'findings',
    triggers: ['schedule', 'manual'],
  }),
  // NO 'manual' below this line. These three exist and are tested, and nothing
  // in the worker can start one on request:
  //
  //   logging_hygiene and performance run INSIDE the anti_slop weekly runner,
  //   on the snapshot it already paid for — they have no runner of their own,
  //   and taking a second tarball for them would be a rate-limit cost for the
  //   same commit.
  //
  //   dependency_cve has runDependencyScan and NO caller anywhere. It is listed
  //   so the catalogue stops claiming it is not installed, and it is not
  //   offered as something a button can start, because today it is not.
  sweeper({
    key: LOGGING_SCANNER_KEY,
    displayName: 'Logging hygiene',
    version: 'logging.v1',
    inputs: 'snapshot',
    triggers: ['schedule'],
  }),
  sweeper({
    key: PERF_SCANNER_KEY,
    displayName: 'Performance patterns',
    version: 'perf.v1',
    inputs: 'snapshot',
    triggers: ['schedule'],
  }),
  sweeper({
    key: DEPENDENCY_SCANNER_KEY,
    displayName: 'Dependency CVEs',
    version: 'dependency.v1',
    inputs: 'manifests',
    triggers: ['schedule'],
    requiredTools: ['syft@1', 'grype@0'],
  }),
];

/**
 * Registers the built-in catalogue. Called once at the top of every process
 * that serves or runs scans — the API (which renders the catalogue) and the
 * worker (which runs it).
 *
 * Idempotent by way of registerScanner's own identity check: re-registering the
 * SAME object is a no-op, and a different scanner under a taken key still
 * throws. That matters because both entrypoints call it and tests import both.
 */
export function registerBuiltinScanners(): void {
  for (const scanner of BUILTIN_SCANNERS) registerScanner(scanner);
}
