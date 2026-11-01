// Security tab wire contracts (W8-10). Source of truth: apps/api/src/routes/security.

export type ScannerState =
  | 'not_enabled'
  | 'never_run'
  | 'ok'
  /** Enqueued or in flight — there is no result to describe yet (W16-38). */
  | 'running'
  /** Claimed by a worker that never came back (W16-39). */
  | 'stale'
  | 'error'
  | 'partial'
  /** Finished without a fault and covered nothing — see the label below. */
  | 'nothing_scanned'
  /** Proposed findings and kept none of them (W16-38). */
  | 'all_rejected';

export interface ScannerStatus {
  key: string;
  display_name: string;
  registered: boolean;
  enabled: boolean;
  state: ScannerState;
  last_run_at: string | null;
  last_run_status: string | null;
  /**
   * W23-01: what the last run did — 'full', 'incremental', or 'skipped' (nothing
   * was re-scanned because an earlier run at this commit still answers it, so
   * `last_run_at` then means "up to date as of"). Absent from older payloads.
   */
  last_run_scope?: string | null;
  /** The earlier run a skipped row restates. */
  last_run_base_run_id?: number | null;
  /**
   * W23-03: for an incremental run, the commit it was measured from, and when the
   * tree was last read in full. Absent from older payloads.
   */
  last_run_base_sha?: string | null;
  last_full_at?: string | null;
  error: string | null;
  scanner_version: string | null;
  /**
   * The checklist's own funnel (W16-38): chunks, proposed, rejected, created.
   * Null for every scanner that has no funnel — which the UI must read as
   * "not measured", never as zero.
   */
  validation_funnel: { proposed?: number; rejected?: number; created?: number } | null;
  open_findings: number;
  /** W20-21 (FND-52): when it runs on its own; absent from older payloads. */
  runs?: {
    on_change: boolean;
    cadence: string | null;
    cron: string | null;
    next_run_at: string | null;
    manual: boolean;
    text: string;
  };
}

export interface ChainNode {
  finding_id: number;
  title: string;
  severity: number;
}

/** The five OpenVEX justifications, verbatim. Source: packages/security/src/vex. */
export type VexJustification =
  | 'component_not_present'
  | 'vulnerable_code_not_present'
  | 'vulnerable_code_not_in_execute_path'
  | 'vulnerable_code_cannot_be_controlled_by_adversary'
  | 'inline_mitigations_already_exist';

/**
 * The funnel the last dependency scan measured (W8-13/W8-14, FR-SEC-15).
 *
 * `raw` is grype's pre-dedup advisory count and is recorded on the scan_run,
 * because nothing downstream can reconstruct it — de-duplication is what the
 * findings table stores the far side of.
 */
export interface ValidationFunnel {
  raw: number;
  deduped: number;
  withAliases: number;
  scoped: {
    prodDirect: number;
    prodTransitive: number;
    dev: number;
    notInResolvedSet: number;
    versionMismatch: number;
    unreadable: number;
  };
  usage: { imported: number; notImported: number; unknown: number };
  reachability: {
    symbolReachable: number;
    provenUnreachable: number;
    imported: number;
    manifestOnly: number;
  };
  /** What the tiers PROPOSED. Nobody has agreed to any of it. */
  proposed: Record<string, number>;
  dismissed: number;
}

export interface VexSummary {
  statements: number;
  not_affected: number;
  affected: number;
  fixed: number;
  by_justification: Record<VexJustification, number>;
}

export const VEX_JUSTIFICATION_LABEL: Record<VexJustification, string> = {
  component_not_present: 'the component is not shipped',
  vulnerable_code_not_present: 'the vulnerable code is not present',
  vulnerable_code_not_in_execute_path: 'the vulnerable code is never executed',
  vulnerable_code_cannot_be_controlled_by_adversary: 'an attacker cannot reach the inputs',
  inline_mitigations_already_exist: 'a mitigation already ships',
};

/** An open finding the Security tab can link straight to (W17-20). */
export interface SecurityFinding {
  id: number;
  title: string;
  severity: number;
  dimension: string;
  scanner_key: string | null;
  file: string | null;
  line: number | null;
}

/**
 * What the scan sandbox can run right now (W17-27). Mirrors
 * packages/security/sandbox/tooling.ts — vuln_db is a fact about a file's age
 * on the host, and the unsupported list is deliberate absences with reasons.
 */
export interface SecurityTooling {
  vuln_db: {
    present: boolean;
    schema: string | null;
    builtAt: string | null;
    ageDays: number | null;
    maxAgeDays: number;
    stale: boolean | null;
    source: string | null;
    reason: string | null;
  };
  scan_tools: string[];
  unsupported_tools: { tool: string; reason: string }[];
}

export interface RepoSecurity {
  repo: { id: number; org: string; name: string };
  open_by_severity: Record<string, number>;
  open_total: number;
  /** Open security-dimension findings, what top_findings is drawn from (W20-13, FND-73). */
  security_open_total?: number;
  /** W20-20 (UX_TODO DSH-77): open findings from rules in trial, left out of the counts. */
  experimental_open?: number;
  scanners: ScannerStatus[];
  /**
   * The worst open security findings, newest API only (W17-20). Optional so a
   * payload from an older API renders the rest of the tab rather than nothing.
   */
  top_findings?: SecurityFinding[];
  /** Optional for the same reason as top_findings. */
  tooling?: SecurityTooling;
  secrets: {
    open: number;
    /** Two clocks: watching new commits vs having looked back. */
    last_stream_scan_at: string | null;
    last_history_scan_at: string | null;
    verified: number;
  };
  /**
   * Open dependency and image CVEs (W20-08, UX_TODO FND-56). `finding_id`
   * links each row to its finding; optional for payloads from before it.
   */
  cves: {
    finding_id?: number;
    cve_id: string;
    package: string;
    severity: number;
    kev: boolean;
    scanner_key?: string | null;
    /** W20-13 (FND-28): the dependency scanner's reachability tier. */
    reachability?: string | null;
    /** W20-21 (FND-28): versions that fix it; empty when none is published. */
    fixed_in?: string[];
  }[];
  chains: { id: string; severity: number; nodes: ChainNode[] }[];
  /** false = chain analysis has never run, which is not the same as no chains. */
  chains_computed: boolean;
  /** null when the last dependency run predates the column, or never happened. */
  validation_funnel: ValidationFunnel | null;
  /** false = nobody wrote the numbers down. NOT the same as all-zero. */
  validation_funnel_recorded: boolean;
  vex: VexSummary;
}

export interface OrgSecurity {
  open_by_severity: Record<string, number>;
  open_total: number;
  /** W20-21 (FND-55): open findings first seen in the last 24 hours, by severity. */
  new_by_severity?: Record<string, number>;
  kev_count: number;
  secrets_open: number;
  verified_secrets: number;
  worst_chain: { id: string; severity: number } | null;
  /** What the numbers are built on, so one scanner does not read as an audit. */
  basis: string;
  /** W20-20 (UX_TODO DSH-76): live credential checks run at all (none do yet). */
  live_checks?: boolean;
  /** W20-20 (DSH-76): scanners that finished in scope, with their last finish. */
  scanners_run?: { key: string; last_finished_at: string }[];
  /** W20-20 (DSH-76): false = no security scan has finished, so zeros mean nothing. */
  scanned?: boolean;
  /** W20-20 (DSH-77): open findings from rules in trial, left out of the counts. */
  experimental_open?: number;
}

/**
 * What each state SAYS, in words.
 *
 * The whole point of the state enum is that a security screen must never show
 * a bare zero: "no findings" from a scanner nobody enabled, one that has never
 * run, and one that ran clean are three different sentences, and only the last
 * is good news.
 */
/**
 * The state in words, given what the scanner still has OPEN (W16-49).
 *
 * Same reason as the code-health screen's: "✓ ran clean" printed beside a
 * non-zero open count is a row contradicting itself, and the tick is the half a
 * reader believes. "Clean" is a claim about findings, not about the process
 * exiting zero. Every other state is unchanged — an errored or interrupted run
 * says nothing about how many findings are open, so the count does not qualify
 * it.
 */
export function scannerStateLabel(
  state: ScannerState,
  openFindings: number | null,
  scope?: string | null,
): string {
  // W23-01: a skipped run did not "run clean" — it re-stated an earlier result.
  if (state === 'ok' && scope === 'skipped') {
    return (openFindings ?? 0) > 0
      ? '✓ up to date — findings still open'
      : '✓ up to date — nothing changed since the last run';
  }
  if (state === 'ok' && (openFindings ?? 0) > 0) return '✓ ran — findings still open';
  return SCANNER_STATE_LABEL[state];
}

/** The coverage table's scope words (W23-01). Unknown scopes are not guessed at. */
export const SCOPE_LABEL: Record<string, string> = {
  full: 'full scan',
  incremental: 'changed files only',
  skipped: 'nothing re-scanned',
};

/**
 * The coverage chip for an incremental run (W23-03): "incremental since a1b2c3d ·
 * last full 14 Oct". The pieces the payload lacks are left out rather than
 * guessed, so an older payload still says "incremental".
 */
export function incrementalChip(
  scope: string | null | undefined,
  baseSha: string | null | undefined,
  lastFullAt: string | null | undefined,
  formatDate: (iso: string) => string,
): string | null {
  if (scope !== 'incremental') return null;
  const parts = ['incremental'];
  if (baseSha) parts[0] = `incremental since ${baseSha.slice(0, 7)}`;
  if (lastFullAt) parts.push(`last full ${formatDate(lastFullAt)}`);
  return parts.join(' · ');
}

/**
 * The "last run" cell: a skipped run says "Up to date as of <date>", never
 * "never" and never a bare date that reads as a fresh scan (W23-01).
 */
export function lastRunText(date: string, scope: string | null | undefined): string {
  return scope === 'skipped' ? `Up to date as of ${date}` : date;
}

/**
 * States in which a scanner has a RESULT — a count shown beside them is a
 * measurement. Every other state gets a dash (W17-20; the rule the coverage
 * table has followed since W8-10, named once so three screens cannot drift).
 */
export function hasMeasuredCount(state: ScannerState): boolean {
  return state === 'ok' || state === 'error' || state === 'partial';
}

/**
 * Did this scanner complete an applicable run — the precondition for "no
 * findings" meaning anything (W17-20)? A failed, interrupted, rejected or
 * empty run has not measured the repository, whatever its count says.
 */
export function ranSuccessfully(scanner: Pick<ScannerStatus, 'state'>): boolean {
  return scanner.state === 'ok' || scanner.state === 'partial';
}

/**
 * Why the vulnerable-dependencies panel is empty, in the words of the
 * dependency scanner's own state (W17-20).
 *
 * The first version said "the CVE scanner is not available yet" whatever had
 * happened — the same sentence over a scanner that had never run, one that
 * had failed, and one that had run and found nothing. Only the last is a
 * clean bill of health, and the panel said the opposite for it.
 */
export function dependencyEmptyCopy(scanner: ScannerStatus | undefined): string {
  const NOT_CLEAN = 'so this is not a clean bill of health.';
  if (!scanner || !scanner.registered) {
    return `No dependency scan can run here — the CVE scanner is not in this build, ${NOT_CLEAN}`;
  }
  switch (scanner.state) {
    case 'not_enabled':
      return `The dependency scanner is not enabled for this repository — nothing has looked, ${NOT_CLEAN}`;
    case 'never_run':
      return `No dependency scan has run for this repository — the CVE scanner has never run here, ${NOT_CLEAN}`;
    case 'running':
      return 'A dependency scan is running now. There is no result to show yet — this is not a clean bill of health, and not a dirty one either.';
    case 'stale':
      return `The last dependency scan was interrupted and never finished, ${NOT_CLEAN}`;
    case 'error':
      return `The last dependency scan failed — its error is in the coverage table above — ${NOT_CLEAN}`;
    case 'nothing_scanned':
      return `The last dependency scan covered nothing, ${NOT_CLEAN}`;
    case 'all_rejected':
      return `The last dependency scan proposed findings and every one was rejected, ${NOT_CLEAN}`;
    case 'partial':
      return scanner.open_findings > 0
        ? `The last dependency scan was cut short and still left ${scanner.open_findings} open — see Open findings above. The set is incomplete.`
        : 'The last dependency scan was cut short. An empty list from an incomplete scan is not a clean bill of health.';
    case 'ok':
      return scanner.open_findings > 0
        ? `The dependency scan ran and left ${scanner.open_findings} open finding${scanner.open_findings === 1 ? '' : 's'} — see Open findings above.`
        : 'The dependency scan ran and found no known vulnerabilities in the resolved dependency set. This one IS a measurement.';
  }
}

export const SCANNER_STATE_LABEL: Record<ScannerState, string> = {
  not_enabled: '○ not enabled — nothing has looked',
  never_run: '· enabled, has never run',
  ok: '✓ ran clean',
  // A scan in flight has no result, and "ran clean" about one that has not
  // finished is a claim with nothing behind it. A checklist takes minutes.
  running: '◐ running now',
  // A worker takes a run and is the only thing that ever clears it, so one
  // that dies mid-scan leaves the row set for ever. Saying "running now" about
  // something that stopped an hour ago is a claim about the present tense.
  stale: '✕ started but never finished — the scan was interrupted',
  // NOT a tick. A sweep with no commits in range, or a repository with no
  // connection, finished without a fault and measured nothing — and a green
  // tick on it is the same lie as "has never run" was, told the other way
  // round. The scanner's own sentence follows underneath.
  nothing_scanned: '○ ran, but nothing was scanned',
  // NOT a tick either. The model looked and proposed findings; the evidence
  // validator threw every one of them out for not quoting the diff verbatim.
  // "Ran clean" over that is the same claim as a tick over an unscanned sweep,
  // and it is the only signal that a prompt or the validator is wrong.
  all_rejected: '! ran, but every finding was rejected',
  error: '✕ last run failed',
  partial: '! last run was cut short — findings are incomplete',
};

/**
 * A CVE row's "Reachable?" cell (W20-13, UX_TODO FND-28), from the dependency
 * scanner's tier. Unknown is said as unknown, never as "no".
 */
export function reachabilityWord(tier: string | null | undefined): string {
  switch (tier) {
    case 'symbol_reachable':
      return 'Yes, called';
    case 'imported':
      return 'Imported';
    case 'manifest_only':
      return 'Listed only';
    case 'proven_unreachable':
      return 'No';
    default:
      return 'Not known';
  }
}
