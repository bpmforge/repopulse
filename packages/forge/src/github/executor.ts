import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import type { ForgeHttpResponse, RequestExecutor } from '../client/budgeted-client.js';

// Prod transport for the GitHubProvider (FORGE_PROVIDER §3, TECH_STACK). The
// BudgetedClient owns rate-limit budgeting AND retry (FR-FORGE-3), so this
// executor must NOT retry or throw on non-2xx — it converts every HTTP outcome
// (incl. 4xx/5xx) back to {status, headers, body} for the budgeter to act on.
// Octokit's throttling/retry plugins are configured to DEFER (return false /
// zero retries): present per TECH_STACK as a last-line safety net, never
// double-retrying against our budgeter. Auth is supplied per-request via the
// headers the BudgetedClient passes through (from AuthHeaderProvider), so no
// auth strategy is configured on the instance.

const OctokitWithPlugins = Octokit.plugin(throttling, retry);

export function createGithubExecutor(): RequestExecutor {
  const octokit = new OctokitWithPlugins({
    userAgent: 'repopulse',
    retry: { enabled: false },
    throttle: {
      // Our budgeter is the single source of retry truth — never retry here.
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
  });

  return async (req): Promise<ForgeHttpResponse> => {
    try {
      const res = await octokit.request({
        method: req.method,
        url: req.url,
        headers: req.headers,
        ...(req.body !== undefined ? { data: req.body } : {}),
      });
      return {
        status: res.status,
        headers: normalizeHeaders(res.headers),
        body: res.data,
      };
    } catch (err: unknown) {
      // Octokit throws on non-2xx — convert back to a response the budgeter
      // can inspect (304/403/429/5xx handling all lives in BudgetedClient).
      const e = err as { status?: number; response?: { headers?: unknown; data?: unknown } };
      if (typeof e.status === 'number' && e.response) {
        return {
          status: e.status,
          headers: normalizeHeaders(e.response.headers),
          body: e.response.data,
        };
      }
      throw err; // genuine network/transport error — let it propagate
    }
  };
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}
