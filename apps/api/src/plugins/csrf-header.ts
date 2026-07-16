import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { sendProblem } from '../lib/problem.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUIRED_HEADER_VALUE = 'repopulse';

// SC-7: SPA is same-origin (CORS disabled entirely - no @fastify/cors is
// registered anywhere, so no route ever emits Access-Control-Allow-Origin).
// Primary defense is SameSite=Lax; this header check is the secondary,
// preflight-protected layer: a cross-origin form/fetch can't attach a
// custom header without triggering a CORS preflight, which fails with no
// ACAO response. Applies globally to every non-safe method on every route
// except /webhooks/* (SC-3 covers webhook auth separately - route doesn't
// exist yet, prefix still declared so it's exempt the moment it ships).
const EXEMPT_PREFIXES = ['/webhooks'];

function isExempt(url: string): boolean {
  return EXEMPT_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));
}

async function csrfHeader(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return undefined;
    if (isExempt(request.url)) return undefined;
    if (request.headers['x-requested-with'] !== REQUIRED_HEADER_VALUE) {
      sendProblem(request, reply, 403, 'Missing or invalid X-Requested-With header');
      return reply;
    }
    return undefined;
  });
}

export default fp(csrfHeader, { name: '@repopulse/api-csrf-header' });
