import type { FastifyReply, FastifyRequest } from 'fastify';

// RFC 7807 application/problem+json per docs/API_DESIGN.md §1. Scoped to
// this route plugin only — a shared envelope helper for all routes is
// W1-04's apps/api/src/plugins/** (error envelope + OpenAPI skeleton).
export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): void {
  reply.code(status).type('application/problem+json').send({
    type: 'about:blank',
    title,
    status,
    detail,
    instance: request.url,
    request_id: request.id,
  });
}

/**
 * End a FAILED browser sign-in on the sign-in screen (W20-04, UX_TODO INS-14).
 *
 * The OIDC and GitHub callbacks are full-page navigations, so a problem+json
 * body there is the whole page: someone whose sign-in failed was left reading
 * raw JSON ("OAuth state mismatch") with no way back. They go back to the SPA
 * instead, carrying a short code the sign-in screen turns into a sentence, and
 * the request id that finds the matching log line. The code is one of OUR
 * reason strings, never the provider's text — that is attacker-influenceable.
 */
export function redirectToSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  loginRedirectUrl: string,
  code: string,
): FastifyReply {
  const query = new URLSearchParams({ auth_error: code, request_id: String(request.id) });
  const separator = loginRedirectUrl.includes('?') ? '&' : '?';
  return reply.redirect(`${loginRedirectUrl}${separator}${query.toString()}`);
}
