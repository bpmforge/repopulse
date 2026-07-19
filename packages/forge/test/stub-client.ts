import type { CallCtx } from '../src/types.js';
import type { ForgeRequest, ForgeResponse } from '../src/client/budgeted-client.js';
import type { ForgeHttpClient } from '../src/github/provider.js';

// In-memory ForgeHttpClient for contract tests: matches a request to a canned
// response by method + url (+ a graphql discriminator), records the calls it
// served, and THROWS on any unmatched request — the same zero-network guarantee
// the replay helper gives, at the client level. No Postgres, no budgeter, no
// network: the provider's request-building + normalization is what's under test.

export interface StubRoute {
  method: string;
  url: string;
  /** For POST /graphql, disambiguate by a substring of the query. */
  bodyIncludes?: string;
  response: { status: number; headers?: Record<string, string>; body: unknown };
}

export interface StubClient extends ForgeHttpClient {
  calls: { method: string; url: string; headers: Record<string, string> }[];
}

export function makeStubClient(routes: StubRoute[]): StubClient {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    async request(_ctx: CallCtx, req: ForgeRequest): Promise<ForgeResponse> {
      // Invoke getHeaders exactly as the real BudgetedClient does, so tests can
      // assert the auth header the provider produced (PAT vs App token).
      const headers = req.getHeaders ? await req.getHeaders() : {};
      calls.push({ method: req.method, url: req.url, headers });
      const route = routes.find((r) => {
        if (r.method !== req.method || r.url !== req.url) return false;
        if (r.bodyIncludes !== undefined) {
          return JSON.stringify(req.body ?? '').includes(r.bodyIncludes);
        }
        return true;
      });
      if (!route) {
        throw new Error(`stub-client: no route for ${req.method} ${req.url} — would hit network`);
      }
      return {
        status: route.response.status,
        headers: route.response.headers ?? {},
        body: route.response.body,
        servedFromCache: false,
      };
    },
  };
}
