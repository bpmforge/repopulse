// Per-repo scanner enablement (W8-01, SECURITY_SUITE.md §1, FR-SEC-11).

export interface ScannerDefault {
  key: string;
  enabled: boolean;
  /** Why this is the default — surfaced in the admin UI, not just here. */
  rationale: string;
  schedule?: 'weekly' | 'manual';
}

/**
 * Workspace defaults (§1).
 *
 * The shape of these defaults is a security posture, not a preference: what is
 * ON by default is what a workspace gets without anyone deciding, which is most
 * workspaces. Cheap-and-high-signal scanners are on; expensive or noisy ones
 * are opt-in, because a scanner that floods the findings list teaches people to
 * ignore findings — and an ignored finding is worse than an absent one.
 */
export const SCANNER_DEFAULTS: readonly ScannerDefault[] = [
  {
    key: 'secrets',
    enabled: true,
    rationale: 'Cheap, high signal, and a leaked credential is exploitable immediately.',
  },
  {
    // KEY CORRECTED IN W16-28, ENABLED IN W16-36. This read 'dependency' for
    // eight waves; the scanner stamps every finding it makes with
    // 'dependency_cve' (DEPENDENCY_SCANNER_KEY), so the default governed a key
    // nothing used and the real scanner had no default at all. It was then
    // left DISABLED on purpose, because runDependencyScan had no caller and an
    // enabled scanner that cannot run is the "presence that reads as
    // capability" that wave existed to remove. The worker wires it now, so the
    // flag goes back to what the rationale always argued for.
    key: 'dependency_cve',
    enabled: true,
    schedule: 'weekly',
    rationale: 'Reads manifests already in the warehouse; no code leaves the network.',
  },
  {
    key: 'semgrep',
    enabled: true,
    schedule: 'weekly',
    rationale: 'Valuable but slow — weekly rather than per-push so it never gates a PR.',
  },
  {
    key: 'owasp_web',
    enabled: false,
    schedule: 'manual',
    rationale: 'Checklist-driven and LLM-backed: costly per run, so a human starts it.',
  },
  {
    key: 'owasp_llm',
    enabled: false,
    rationale: 'Auto-enabled only when the dependency scanner detects LLM dependencies (§3.4).',
  },
  {
    key: 'attack_chainer',
    enabled: true,
    rationale: 'Costs nothing without prior findings — it only reads what other scanners produced.',
  },
  // THE SCANNERS THE CRON ALREADY RUNS (W16-28).
  //
  // Every key below has had a weekly or nightly runner wired in the worker
  // since W9/W10 and no entry here, so the admin screen listed neither a
  // default nor a rationale for work that was happening anyway. A default is a
  // security posture; one that omits half of what runs is not a posture, it is
  // an oversight with a table around it.
  {
    key: 'code_health_tools',
    enabled: true,
    schedule: 'weekly',
    rationale: 'Complexity and duplication are properties of a codebase, not of a change.',
  },
  {
    key: 'anti_slop',
    enabled: true,
    schedule: 'weekly',
    rationale: 'Runs on the snapshot code health already paid for, so it costs one extra pass.',
  },
  {
    key: 'logging_hygiene',
    enabled: true,
    schedule: 'weekly',
    rationale: 'Shares the anti-slop snapshot; a logged credential is a leak with a timestamp.',
  },
  {
    key: 'performance',
    enabled: true,
    schedule: 'weekly',
    rationale: 'Eight structural rules on the same snapshot — no judgement half, no model cost.',
  },
  {
    key: 'supply_chain_register',
    enabled: true,
    rationale: 'Deprecations and EOL dates happen on a date rather than on a commit, so nightly.',
  },
  {
    key: 'architecture_register',
    enabled: true,
    rationale: 'Module boundaries drift silently; the register is the only thing that notices.',
  },
  {
    key: 'test_gap_register',
    enabled: true,
    rationale: 'Reads coverage the warehouse already holds — no snapshot, no tool.',
  },
  {
    key: 'knowledge_register',
    enabled: true,
    rationale: 'Bus-factor and ownership come from history already ingested.',
  },
  {
    key: 'rule_draft_pass',
    enabled: true,
    schedule: 'weekly',
    rationale: 'Drafts from a 30-day dismissal window; nightly would re-draft the same clusters.',
  },
];

export function defaultFor(key: string): ScannerDefault | undefined {
  return SCANNER_DEFAULTS.find((d) => d.key === key);
}

/** Effective enablement: a stored row wins, otherwise the documented default. */
export function isEnabled(key: string, stored: { enabled: boolean } | undefined): boolean {
  // `??` on the ROW, not the boolean: a row that explicitly says `false` must
  // beat a default of `true`. Reading `stored?.enabled ?? default` would be
  // correct here by luck and wrong the moment a default flips.
  return stored ? stored.enabled : (defaultFor(key)?.enabled ?? false);
}
