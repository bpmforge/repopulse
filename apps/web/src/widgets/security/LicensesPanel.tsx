import { useApiQuery } from '../../api/useApiQuery.js';
import { ErrorNote } from '../../components/index.js';
import { InternalLink } from '../plans/InternalLink.js';
import { SEVERITY_LABEL, type FindingPage } from '../findings/contracts.js';

// Security tab → Licenses (W20-08, UX_TODO FND-18).
//
// The license register raised `license.policy` and `license.unknown` findings
// that only surfaced in the generic findings list, with nothing saying which
// policy produced them or where to change it. This panel lists the ones still
// to fix for this repository and links the policy that decides them.

export const LICENSE_RULES = ['license.policy', 'license.unknown'] as const;

const RULE_LABEL: Record<(typeof LICENSE_RULES)[number], string> = {
  'license.policy': 'Flagged by policy',
  'license.unknown': 'License not readable',
};

function useLicenseFindings(repoId: string, ruleId: string) {
  return useApiQuery<FindingPage>({
    endpoint: '/findings',
    query: { repo_id: repoId, rule_id: ruleId, status: 'active', limit: '50' },
  });
}

export function LicensesPanel({ repoId }: { repoId: string }) {
  const policy = useLicenseFindings(repoId, 'license.policy');
  const unknown = useLicenseFindings(repoId, 'license.unknown');
  const loading = policy.isLoading || unknown.isLoading;
  const rows = [
    ...(policy.data?.items ?? []).map((f) => ({ f, rule: 'license.policy' as const })),
    ...(unknown.data?.items ?? []).map((f) => ({ f, rule: 'license.unknown' as const })),
  ];

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="security-licenses-body">
      {loading ? (
        <p className="text-fg-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-fg-muted" data-testid="licenses-empty">
          No license findings to fix. That reflects the policy below and the last dependency scan:
          with no SBOM stored, the register has nothing to check.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ f, rule }) => (
            <li key={f.id} className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs text-fg-muted">
                {SEVERITY_LABEL[f.severity] ?? f.severity}
              </span>
              <InternalLink
                to="/findings"
                search={{ finding: String(f.id), repos: repoId }}
                className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                testId={`license-finding-${f.id}`}
              >
                {f.title}
              </InternalLink>
              <span className="text-xs text-fg-muted">{RULE_LABEL[rule]}</span>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={policy.error ?? unknown.error} testId="licenses-error" />
      <p className="text-xs text-fg-muted">
        What gets flagged is the workspace license policy —{' '}
        <InternalLink
          to="/admin/settings"
          className="text-accent hover:underline"
          testId="licenses-policy-link"
        >
          Settings → License policy
        </InternalLink>
        .
      </p>
    </div>
  );
}
