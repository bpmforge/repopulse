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
