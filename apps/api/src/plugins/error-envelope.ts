import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { sendProblem } from '../lib/problem.js';

// Global RFC 7807 error envelope (API_DESIGN.md §1/§4) — fastify-plugin
// wrapped so setErrorHandler/setNotFoundHandler apply app-wide regardless
// of where this gets registered, same pattern as W1-03's session plugin.
async function errorEnvelope(app: FastifyInstance): Promise<void> {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      sendProblem(request, reply, 400, 'Request validation failed', {
        detail: error.message,
        errors: error.validation.map((issue) => ({
          path: issue.instancePath || '/',
          message: issue.message,
        })),
      });
      return;
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response failed schema serialization');
      sendProblem(request, reply, 500, 'Internal Server Error');
      return;
    }

    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }
    sendProblem(request, reply, status, status === 500 ? 'Internal Server Error' : error.message);
  });

  app.setNotFoundHandler((request, reply) => {
    sendProblem(request, reply, 404, 'Not Found');
  });
}

export default fp(errorEnvelope, { name: '@repopulse/api-error-envelope' });
