import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendProblem } from './problem.js';

export interface RequestWorkspace {
  id: number;
  slug: string;
  name: string;
}

export type RequestRole = 'admin' | 'member';

declare module 'fastify' {
  interface FastifyRequest {
    workspace?: RequestWorkspace;
    role?: RequestRole;
  }
}

// Per-route guard for 👑 admin routes (API_DESIGN.md §2/FR-AUTH-4). Attach
// via route options: { preHandler: requireAdmin }. Runs after the
// /api/v1 plugin's session+workspace preHandler, which populates
// request.role — undefined only if that hook was skipped, which can't
// happen for a route registered inside the guarded /api/v1 scope.
//
// Only an admin gate exists because the catalog's RBAC model is binary:
// member is the unrestricted baseline and admin is a superset of it, so
// there is no "member-only, admin excluded" route to guard against.
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  if (request.role !== 'admin') {
    sendProblem(request, reply, 403, 'Forbidden — admin role required');
    return reply;
  }
  return undefined;
}
