import {
  createAuthHeaderProvider,
  createGithubExecutor,
  GitHubProvider,
  type ForgeHttpClient,
  type ForgeProvider,
  type GitHubAuth,
} from '@repopulse/forge';

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

export function buildDiscoveryProvider(auth: GitHubAuth, baseUrl?: string): ForgeProvider {
  // baseUrl is a real deployment option, not a test seam: GitHub Enterprise
  // Server lives at a customer's own host, which a self-hosted product (D1a)
  // has to support. e2e uses the same door to point at a fake forge.
  return new GitHubProvider({
    client: statusAwareClient(createGithubExecutor()),
    auth: createAuthHeaderProvider(auth),
    ...(baseUrl ? { baseUrl } : {}),
  });
}
