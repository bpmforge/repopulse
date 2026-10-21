// Where a headline number's evidence lives (W20-20, UX_TODO DSH-18 / DSH-51).
//
// Principle 3, "every number is a door": the KPI tiles and the pulse bullets
// were plain text. Each metric goes to the screen whose rows add up to it — a
// list filtered to the items behind the number where one exists, otherwise
// the repository tab that charts it. A metric with no such screen (issue
// throughput has none) gets no link rather than a link to somewhere unrelated.

export interface EvidenceLink {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  label: string;
}

/** `repos` is the topbar/view csv; one id means the repository's own tabs. */
export function metricEvidence(key: string, repos?: string): EvidenceLink | null {
  const single = repos && repos !== 'all' && !repos.includes(',') ? repos : undefined;
  const scoped = repos && repos !== 'all' ? { repos } : {};
  switch (key) {
    case 'M5':
    case 'M6':
      return {
        to: '/pull-requests',
        search: { ...scoped, state: 'merged', unreviewed: true },
        label: 'merged pull requests without a review',
      };
    case 'M4':
      return single
        ? { to: '/repos/$repoId/pr-flow', params: { repoId: single }, label: 'PR flow' }
        : {
            to: '/pull-requests',
            search: { ...scoped, state: 'merged' },
            label: 'merged pull requests',
          };
    case 'M8':
      return {
        to: '/pull-requests',
        search: { ...scoped, state: 'open', stale: true },
        label: 'stale pull requests',
      };
    case 'M9':
      return single
        ? { to: '/repos/$repoId/ci', params: { repoId: single }, label: 'CI' }
        : { to: '/repos', label: 'repositories (open one for its CI tab)' };
    case 'M1':
      return single
        ? { to: '/repos/$repoId/activity', params: { repoId: single }, label: 'activity' }
        : { to: '/repos', label: 'repositories (open one for its activity)' };
    case 'findings':
      return { to: '/findings', search: scoped, label: 'findings' };
    case 'plan':
      return { to: '/plans', label: 'improvement plans' };
    default:
      return null;
  }
}
