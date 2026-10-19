// The repository scope a widget runs under (W20-09, UX_TODO DSH-02).
//
// A saved view (and the Overview's topbar filter) hands every widget its
// `search`, whose `repos` is a csv of repository ids or absent for all of
// them. The KPI row, pulse, next actions, plan, security and risk tiles used
// to ignore it and always show the whole workspace beside repo-scoped cards.

/** `repos` as the API's csv, or undefined for the whole workspace. */
export function reposParam(search: Record<string, string> | undefined): string | undefined {
  const repos = search?.repos;
  return repos && repos !== 'all' ? repos : undefined;
}

/** A query object that carries `repos` only when there is a scope. */
export function withRepos(
  query: Record<string, string>,
  repos: string | undefined,
): Record<string, string> {
  return repos ? { ...query, repos } : query;
}
