import {
  createAuthHeaderProvider,
  createGithubExecutor,
  DEFAULT_GITHUB_BASE_URL,
  DEFAULT_GITLAB_BASE_URL,
  GitHubProvider,
  GiteaProvider,
  GitLabProvider,
  type ForgeHttpClient,
  type ForgeProvider,
  type GitHubAuth,
} from '@repopulse/forge';

/** Which forge a connection speaks to. Mirrors the connections schema enum. */
export type ForgeKind = 'github' | 'gitea' | 'gitlab';

// Builds a ForgeProvider for connect-time discovery/validation calls. These are
// one-shot (listRepos smoke, registerWebhook) — NOT part of steady-state
// ingestion — so they skip the BudgetedClient's Postgres etag layer (which
// would need a connection row that may not exist yet) and use a thin
// status-aware client: any 4xx/5xx is thrown with `.status` so the connect flow
// can distinguish bad_token (401) from bad_scope (403). Law 7 still holds for
// real ingestion, which goes through the BudgetedClient (W2-03).

function statusAwareClient(executor: ReturnType<typeof createGithubExecutor>): ForgeHttpClient {
  return {
    async request(_ctx, req) {
      const headers = req.getHeaders ? await req.getHeaders() : {};
      const res = await executor({
        method: req.method,
        url: req.url,
        headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      if (res.status >= 400) {
        const err = new Error(`forge responded ${res.status}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return { ...res, servedFromCache: false };
    },
  };
}

/**
 * The ONE place a connection's base URL is decided (W20-07, UX_TODO INS-73).
 *
 * The API filled a blank GitLab URL as gitlab.com (the adapter's default) but
 * stored null; the worker then filled the null with FORGE_BASE_URL or the
 * GitHub default and wrote THAT onto the row — so a gitlab.com connection
 * backfilled against api.github.com/api/v4 and every call 404'd, and from then
 * on the picker failed too. Both now call this, the API stores the answer at
 * creation, and the worker only falls back here for rows made before that.
 *
 *  - an explicit URL always wins;
 *  - GitLab: gitlab.com. FORGE_BASE_URL is the server's GitHub-or-Gitea
 *    fallback and says nothing about GitLab;
 *  - GitHub: FORGE_BASE_URL (GitHub Enterprise Server, the e2e fake), else
 *    api.github.com;
 *  - Gitea: FORGE_BASE_URL or nothing — it is self-hosted, so the caller
 *    refuses rather than guesses.
 */
export function resolveConnectionBaseUrl(
  kind: ForgeKind,
  given: string | null | undefined,
  serverDefault: string | undefined,
): string | undefined {
  if (given) return given;
  if (kind === 'gitlab') return DEFAULT_GITLAB_BASE_URL;
  if (kind === 'github') return serverDefault ?? DEFAULT_GITHUB_BASE_URL;
  return serverDefault;
}

/**
 * A row the old worker fallback broke: a GitLab connection stored with the
 * GitHub API host, which can never be right. Callers repair it to gitlab.com.
 */
export function isMisresolvedGitlabRow(kind: string, baseUrl: string | null): boolean {
  return kind === 'gitlab' && baseUrl?.replace(/\/+$/, '') === DEFAULT_GITHUB_BASE_URL;
}

export interface ProviderArgs {
  client: ForgeHttpClient;
  auth: ReturnType<typeof createAuthHeaderProvider>;
  baseUrl?: string | undefined;
}

/**
 * THE construction site (W14-02).
 *
 * Deciding which adapter to instantiate is the one thing a capability flag
 * cannot express — there is no provider yet to ask — so the capability gate
 * allows exactly this file to branch on the forge kind. The worker's ingestion
 * path calls in here rather than growing a second switch, which is what the
 * gate exists to prevent: two construction sites are two places for a new
 * forge to be half-added.
 */
export function providerForKind(kind: ForgeKind, args: ProviderArgs): ForgeProvider {
  const { client, auth, baseUrl } = args;
  const withBase = { client, auth, ...(baseUrl ? { baseUrl } : {}) };

  if (kind === 'gitlab') return new GitLabProvider(withBase);
  if (kind === 'gitea') {
    if (!baseUrl) {
      throw new Error('Gitea is self-hosted: the connection needs its own base URL');
    }
    return new GiteaProvider({ client, auth, baseUrl });
  }
  return new GitHubProvider(withBase);
}

export function buildDiscoveryProvider(
  auth: GitHubAuth,
  baseUrl?: string,
  kind: ForgeKind = 'github',
): ForgeProvider {
  // baseUrl is a real deployment option, not a test seam: GitHub Enterprise
  // Server lives at a customer's own host, which a self-hosted product (D1a)
  // has to support. e2e uses the same door to point at a fake forge.
  // Selected by the connection's declared forge, never sniffed from the URL:
  // a self-managed GitLab and a self-hosted Gitea can sit on indistinguishable
  // hostnames, and guessing wrong produces 404s that read as bad credentials.
  return providerForKind(kind, {
    client: statusAwareClient(createGithubExecutor()),
    auth: createAuthHeaderProvider(auth),
    baseUrl,
  });
}
