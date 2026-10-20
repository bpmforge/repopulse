// Which global filters MEAN anything on a given screen (W16-50).
//
// The topbar offered all three everywhere. Two of them did nothing anywhere —
// the repository picker was never given options and no screen read `?repos=` or
// `?person=` — and even `window` was decorative on half the product: the org PR
// list is not windowed, the findings explorer has no time dimension, Reports
// carries its own window control, and Plans hardcoded 30d while the global
// control sat directly above the button.
//
// A control that silently does nothing is worse than a missing one: it is the
// opposite of this codebase's rule that nothing on screen claims what it has
// not earned. So the topbar now renders exactly the filters the screen it is
// sitting above actually applies, and the ones it renders all work.
//
// Keyed on the PATH rather than declared by each screen, for the same reason
// deriveCrumbs is: the topbar renders above the outlet and cannot ask the route
// below it what it supports without a context every screen would have to
// remember to fill in — and a screen that forgot would silently get the old
// behaviour back.

export interface FilterScope {
  window: boolean;
  repos: boolean;
  person: boolean;
}

const NONE: FilterScope = { window: false, repos: false, person: false };

/**
 * The repository tabs that read the window (W20-16, UX_TODO DSH-62). Security,
 * Findings, Code Health, Performance, a file and a PR's own page are not
 * time-windowed, so the control is not offered there: changing it did nothing.
 * '' is the repository's Pulse tab; 'prs' is the PR list, not one PR.
 */
const WINDOWED_REPO_TABS = new Set([
  '',
  'activity',
  'hotspots',
  'pr-flow',
  'ai-reviewers',
  'ci',
  'prs',
]);

/**
 * The filters that apply to `pathname`.
 *
 * Anything not matched gets NONE — an unknown screen has not been checked, and
 * offering it a filter it may not honour is exactly the defect being fixed.
 */
export function filterScopeFor(pathname: string): FilterScope {
  // A repository's own screens ARE the repo filter, so offering a picker that
  // could contradict the page you are on would be worse than offering none.
  if (pathname.startsWith('/repos/')) {
    const [, , , tab = '', ...rest] = pathname.replace(/\/+$/, '').split('/');
    return {
      window: WINDOWED_REPO_TABS.has(tab) && rest.length === 0,
      repos: false,
      person: false,
    };
  }
  if (pathname === '/repos') return { window: true, repos: true, person: false };
  // The ORG overview is deliberately not repo-filtered. Its nine widgets read
  // five org-rollup endpoints that have no repo_id, and the screen already has
  // a better answer to "just this repository": every health tile links to it.
  // Offering the picker here would mean either five API changes or a control
  // that narrows three widgets and silently ignores six.
  if (pathname === '/') return { window: true, repos: false, person: false };
  // The org PR list is a cohort browser, not a windowed metric: it has its own
  // state/size/stale filters and pages by cursor. Repo and person narrow it.
  if (pathname.startsWith('/pull-requests')) return { window: false, repos: true, person: true };
  // Findings have no time dimension — a finding is open until someone closes
  // it, and a window would quietly hide the oldest ones, which are the ones
  // that matter most.
  if (pathname.startsWith('/findings')) return { window: false, repos: true, person: false };
  // Sensitive changes honours ?repos= (Reviews carries it across), so the
  // picker must show there or the narrowing is invisible and cannot be
  // cleared (W20-15, UX_TODO X-26). Like findings, it has no window.
  if (pathname.startsWith('/sensitive-changes'))
    return { window: false, repos: true, person: false };
  // Plans are generated FOR a window and a repository set and then keep them;
  // the controls pick the scope the next one is generated over, and the list
  // narrows to plans with exactly that scope (W17-24).
  if (pathname.startsWith('/plans')) return { window: true, repos: true, person: false };
  // AI-code governance reads both (W20-16, UX_TODO DSH-61); its own copy
  // sends people to "the filter bar", which it did not have.
  if (pathname.startsWith('/governance')) return { window: true, repos: true, person: false };
  // My Focus is already scoped to one person: you.
  if (pathname.startsWith('/me')) return NONE;
  // Reports and Views each carry their own scope — a report pins its window at
  // generation, and a saved view stores one.
  return NONE;
}
