// METRICS.md §0 shared rule: exclude bot activity from every human-flow
// metric. Bot activity remains queryable elsewhere - this only decides
// membership, callers choose what to do with it.
export const DEFAULT_BOT_LOGIN_GLOBS: readonly string[] = [
  '*[bot]',
  'dependabot*',
  'renovate*',
  'github-actions*',
];

// Patterns here only ever use a single leading/trailing `*` (verified
// against METRICS.md §0's exact glob list) - a minimal glob-to-regex avoids
// pulling in a glob-matching dependency for four fixed patterns.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function isBotLogin(
  login: string,
  globs: readonly string[] = DEFAULT_BOT_LOGIN_GLOBS,
): boolean {
  return globs.some((glob) => globToRegExp(glob).test(login));
}
