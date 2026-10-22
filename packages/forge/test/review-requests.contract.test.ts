import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { normalizeReviewRequest } from '../src/github/normalize.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// When each reviewer was asked (W20-24, UX_TODO DSH-41). GitHub's issue events
// (GET /repos/{owner}/{repo}/issues/{n}/events) carry `review_requested` with
// `created_at`, `requested_reviewer` (a person) and `review_requester`; a team
// request has `requested_team` instead and names nobody's queue. Field names
// checked against docs.github.com "Issue event types" (review_requested).

const ctx: CallCtx = { lane: 'reconcile' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'review_requests_contract' });
const REPO = 'acme/widgets';
const URL1 = `https://api.github.com/repos/${REPO}/issues/12/events?per_page=100`;

const github = (routes: StubRoute[]) => {
  const client = makeStubClient(routes);
  return { client, provider: new GitHubProvider({ client, auth }) };
};

const requested = (login: string, at: string) => ({
  id: 1,
  event: 'review_requested',
  created_at: at,
  actor: { login: 'dana' },
  review_requester: { login: 'dana' },
  requested_reviewer: { login },
});

describe('GitHub review requests (W20-24, DSH-41)', () => {
  it('keeps person review requests and drops every other event', async () => {
    const { client, provider } = github([
      {
        method: 'GET',
        url: URL1,
        response: {
          status: 200,
          body: [
            { id: 2, event: 'labeled', created_at: '2026-10-01T00:00:00Z' },
            requested('ana', '2026-10-02T09:00:00Z'),
            {
              id: 3,
              event: 'review_requested',
              created_at: '2026-10-03T00:00:00Z',
              requested_team: { slug: 'core' },
            },
            { id: 4, event: 'review_request_removed', created_at: '2026-10-04T00:00:00Z' },
          ],
        },
      },
    ]);
    const page = await provider.listReviewRequests(ctx, REPO, 12);
    expect(client.calls).toHaveLength(1);
    expect(page).toEqual({
      items: [{ prNumber: 12, reviewerLogin: 'ana', requestedAt: '2026-10-02T09:00:00Z' }],
    });
  });

  it('follows the Link header', async () => {
    const { provider } = github([
      {
        method: 'GET',
        url: URL1,
        response: {
          status: 200,
          headers: { link: `<${URL1}&page=2>; rel="next", <${URL1}&page=2>; rel="last"` },
          body: [requested('ana', '2026-10-02T09:00:00Z')],
        },
      },
      {
        method: 'GET',
        url: `${URL1}&page=2`,
        response: { status: 200, body: [requested('bo', '2026-10-05T09:00:00Z')] },
      },
    ]);
    const first = await provider.listReviewRequests(ctx, REPO, 12);
    expect(first.nextCursor).toBe('2');
    const second = await provider.listReviewRequests(ctx, REPO, 12, first.nextCursor);
    expect(second.items.map((r) => r.reviewerLogin)).toEqual(['bo']);
  });

  it('rejects an error answer rather than reading it as no requests', async () => {
    const { provider } = github([
      { method: 'GET', url: URL1, response: { status: 403, body: { message: 'nope' } } },
    ]);
    await expect(provider.listReviewRequests(ctx, REPO, 12)).rejects.toThrow();
  });

  it('a request with no person or no time is not a request', () => {
    expect(normalizeReviewRequest({ event: 'review_requested' }, 1)).toBeNull();
    expect(
      normalizeReviewRequest(
        { event: 'review_requested', created_at: 'x', requested_reviewer: null },
        1,
      ),
    ).toBeNull();
  });
});
