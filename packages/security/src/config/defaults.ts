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
    key: 'dependency',
    enabled: true,
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
