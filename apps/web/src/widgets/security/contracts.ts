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
  error: string | null;
  scanner_version: string | null;
  /**
   * The checklist's own funnel (W16-38): chunks, proposed, rejected, created.
   * Null for every scanner that has no funnel — which the UI must read as
   * "not measured", never as zero.
   */
  validation_funnel: { proposed?: number; rejected?: number; created?: number } | null;
  open_findings: number;
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
  kev_count: number;
  secrets_open: number;
  verified_secrets: number;
  worst_chain: { id: string; severity: number } | null;
  /** What the numbers are built on, so one scanner does not read as an audit. */
  basis: string;
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
export function scannerStateLabel(state: ScannerState, openFindings: number | null): string {
  if (state === 'ok' && (openFindings ?? 0) > 0) return '✓ ran — findings still open';
  return SCANNER_STATE_LABEL[state];
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
