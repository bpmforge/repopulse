import { registerScanner } from './registry.js';
import type { Scanner, ScannerContext, ScannerFinding } from './framework/types.js';
import { SECRETS_SCANNER_KEY } from './scanners/secrets/scanner.js';
import { SEMGREP_SCANNER_KEY } from './scanners/semgrep/scanner.js';
import { DEPENDENCY_SCANNER_KEY } from './scanners/dependency/findings.js';
import { IMAGE_SCANNER_KEY } from './scanners/image/findings.js';
import { CODE_HEALTH_SCANNER_KEY } from './scanners/code-health/tools.js';
import { ANTI_SLOP_SCANNER_KEY } from './scanners/anti-slop/run.js';
import { LOGGING_SCANNER_KEY } from './scanners/logging/run.js';
import { PERF_SCANNER_KEY } from './scanners/perf/run.js';
import {
  SENSITIVE_CHANGE_SCANNER_KEY,
  SENSITIVE_CHANGE_VERSION,
} from './scanners/sensitive-change/run.js';
import { CHAINER_SCANNER_KEY } from './scanners/chainer/run.js';
import { ARCHITECTURE_SCANNER_KEY } from './adapters/architecture/tools.js';
import { SUPPLY_CHAIN_REGISTER_KEY } from './registers/run.js';
import { DRAFT_PASS_KEY } from './rules/draft-run.js';
import { CODE_SCANNING_PULL_KEY, CODE_SCANNING_PULL_VERSION } from './external/code-scanning.js';
import { SLOPSQUAT_SCANNER_KEY, SLOPSQUAT_VERSION } from './scanners/slopsquat/findings.js';

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
        "through the worker's runner map, not against one pinned commit. " +
        'Enqueue it with mode "history" or "weekly".',
    );
  };
}

function sweeper(s: Omit<Scanner, 'run'>): Scanner {
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
    // W21-02: pr_synced runs over the PR's changed files only, out of the one
    // snapshot every PR pattern scanner shares (scanners/pr/run.ts).
    triggers: ['pr_synced', 'schedule', 'manual'],
    requiredTools: ['opengrep@1'],
    // W23-03: Opengrep's OSS rules judge one file at a time, so a manual or
    // weekly run may scan only what changed since the last full answer. The cap
    // is the PR path's own (runSemgrepIncremental's maxFiles).
    incremental: { maxChangedFiles: 200 },
  }),
  sweeper({
    key: CODE_HEALTH_SCANNER_KEY,
    displayName: 'Code health (complexity, duplication)',
    version: 'code_health.v1',
    inputs: 'snapshot',
    triggers: ['schedule', 'manual'],
    requiredTools: ['lizard@1', 'jscpd@4'],
    // W23-03: lizard and the 'file'-scope adapters judge one file at a time.
    // jscpd (duplication) does not, and is left to full runs — see
    // code-health/run.ts, tryIncremental.
    incremental: { maxChangedFiles: 200 },
  }),
  sweeper({
    key: ANTI_SLOP_SCANNER_KEY,
    displayName: 'Anti-slop',
    version: 'anti_slop.v1',
    inputs: 'snapshot',
    // W21-02: deterministic half only on a PR push, reporting on changed files.
    triggers: ['pr_synced', 'schedule', 'manual'],
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
    // Schedule only (2026-10-30). Started by "Run scan" beside every scanner,
    // its 45,000-token rule-tweak proposals held LM Studio's one slot for 20
    // minutes and anti-slop failed twice on outline. It is weekly learning
    // over a 30-day window; a person pressing the button wants the scan.
    triggers: ['schedule'],
  }),
  // W16-33 gave both of these a runner. MANUAL only, and not on the weekly
  // cron: a checklist is a gateway call per chunk, and their own defaults say
  // "costly per run, so a human starts it". They also read a DIFF rather than
  // a snapshot, which is why they are not in the weekly group above.
  sweeper({
    key: 'owasp_web',
    displayName: 'OWASP Web checklist',
    version: 'owasp_web.v1',
    inputs: 'diff',
    triggers: ['manual'],
  }),
  sweeper({
    key: 'owasp_llm',
    displayName: 'OWASP LLM checklist',
    version: 'owasp_llm.v1',
    inputs: 'diff',
    triggers: ['manual'],
  }),
  sweeper({
    key: DEPENDENCY_SCANNER_KEY,
    displayName: 'Dependency CVEs',
    version: 'dependency.v1',
    inputs: 'manifests',
    // STARTABLE AS OF W16-36. It had no caller anywhere for eight waves, so it
    // was catalogued without 'manual' — listed, so the screen stopped claiming
    // it was not installed, and not offered, because no button could reach it.
    // The worker wires it now. W21-02: on a PR push only when the PR changed a
    // manifest or lockfile (PR_CONDITIONAL_SCANNERS).
    triggers: ['pr_synced', 'schedule', 'manual'],
    requiredTools: ['syft@1', 'grype@0'],
  }),
  // W18-34. OFF BY DEFAULT: pulls the images named in Dockerfiles, compose files
  // and Kubernetes manifests from their registries (host-side, skopeo) and scans
  // them with grype. A self-hoster turns it on per repository and supplies any
  // private-registry credentials through IMAGE_SCAN_AUTH_FILE.
  sweeper({
    key: IMAGE_SCANNER_KEY,
    displayName: 'Container image CVEs',
    version: 'container_image.v1',
    inputs: 'manifests',
    // W21-02: still opt-in; once on, a PR push that changes a file naming an
    // image runs it too (PR_CONDITIONAL_SCANNERS).
    triggers: ['pr_synced', 'manual'],
    requiredTools: ['grype@0'],
  }),
  // W18-24. Reads GitHub code-scanning alerts through the budgeted client —
  // no snapshot, no container. Nightly with the registers, and startable by
  // hand. It needs a GitHub App permission the default registration does not
  // request, and says so on its run row instead of failing.
  sweeper({
    key: CODE_SCANNING_PULL_KEY,
    displayName: 'GitHub code scanning alerts (import)',
    version: CODE_SCANNING_PULL_VERSION,
    inputs: 'findings',
    triggers: ['schedule', 'manual'],
  }),
  // NO 'manual' below this line. These two exist and are tested, and nothing
  // in the worker can start one on request: logging_hygiene and performance
  // run INSIDE the anti_slop weekly runner, on the snapshot it already paid
  // for — they have no runner of their own, and taking a second tarball for
  // them would be a rate-limit cost for the same commit.
  sweeper({
    key: LOGGING_SCANNER_KEY,
    displayName: 'Logging hygiene',
    version: 'logging.v1',
    inputs: 'snapshot',
    // W21-02: and on every PR push, over the changed files (pack only).
    triggers: ['pr_synced', 'schedule'],
  }),
  // W18-21. Arrivals only: it runs inside the secrets stream on the diff that
  // scan already fetched, so it has no runner of its own and no 'manual' —
  // and no 'schedule', because a weekly pass has no change to judge.
  sweeper({
    key: SENSITIVE_CHANGE_SCANNER_KEY,
    displayName: 'Sensitive-change radar',
    version: SENSITIVE_CHANGE_VERSION,
    inputs: 'diff',
    triggers: ['pr_synced', 'push'],
  }),
  // W21-05. Two runners, no manual button of its own: diff mode rides the
  // secrets stream on pr_synced/push (as the radar does), and snapshot mode
  // runs inside the weekly dependency scan, on the snapshot that scan holds.
  sweeper({
    key: SLOPSQUAT_SCANNER_KEY,
    displayName: 'Hallucinated and typosquatted packages',
    version: SLOPSQUAT_VERSION,
    inputs: 'manifests',
    triggers: ['pr_synced', 'push', 'schedule'],
  }),
  sweeper({
    key: PERF_SCANNER_KEY,
    displayName: 'Performance patterns',
    version: 'perf.v1',
    inputs: 'snapshot',
    triggers: ['pr_synced', 'schedule'],
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
