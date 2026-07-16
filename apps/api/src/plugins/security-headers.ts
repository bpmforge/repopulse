import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

// SC-23: exact CSP string from docs/SECURITY_CONTROLS.md - `useDefaults:
// false` is required, otherwise @fastify/helmet merges in its own extra
// directives (font-src, form-action, img-src, style-src,
// upgrade-insecure-requests) on top of ours (verified empirically against
// the installed @fastify/helmet 13.1.0). Helmet's other defaults
// (X-Content-Type-Options: nosniff, etc.) are kept as-is - SC-23 asks for
// nosniff specifically and doesn't forbid helmet's other hardening headers.
async function securityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
  });
}

export default fp(securityHeaders, { name: '@repopulse/api-security-headers' });
