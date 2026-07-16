import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ProblemFieldError {
  path: string;
  message: string;
}

export interface ProblemOptions {
  type?: string;
  detail?: string;
  /** zod validation failures -> 400 with field errors array (API_DESIGN.md §1). */
  errors?: ProblemFieldError[];
}

// The canonical RFC 7807 application/problem+json envelope — copy the
// shape in API_DESIGN.md §4 exactly: {type, title, status, detail,
// instance, request_id}. This supersedes apps/api/src/routes/auth's
// ticket-local helper of the same shape (out of this ticket's write_scope
// to touch; see plan.json W1-04 notes for the migration HANDOFF).
export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  opts: ProblemOptions = {},
): void {
  reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: opts.type ?? 'about:blank',
      title,
      status,
      detail: opts.detail,
      instance: request.url,
      request_id: request.id,
      ...(opts.errors ? { errors: opts.errors } : {}),
    });
}
