import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { verifyWebhookSignature } from '@repopulse/forge';
import {
  deltaEnqueueSpec,
  recordDelivery,
  routeEvent,
  type DeltaEnqueueSpec,
} from '@repopulse/ingest';
import { sendProblem } from '../../lib/problem.js';

// Webhook receiver (INGESTION §4, SC-3/SC-4, FR-INGEST-5/6). Machine-facing, no
// session (API_DESIGN §1 exempts /webhooks/*). Must answer <10s: verify the
// HMAC over the RAW body, dedupe on delivery_id, enqueue a typed delta job,
// respond 202. A tampered/absent signature ⇒ 401, nothing enqueued.

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface WebhookRoutesOptions {
  db: Database;
  tokenKey: Buffer;
  /** Enqueue the delta (BullMQ queue.add wrapped by the runtime). */
  enqueueDelta: (spec: DeltaEnqueueSpec) => Promise<void>;
  /** Optional invalid-signature counter (NFR-12). */
  onInvalidSignature?: () => void;
}

interface GithubPayload {
  action?: string;
  repository?: { full_name?: string };
}

function unauthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: WebhookRoutesOptions,
): FastifyReply {
  opts.onInvalidSignature?.();
  sendProblem(request, reply, 401, 'Invalid webhook signature');
  return reply;
}

export default async function webhookRoutes(
  app: FastifyInstance,
  opts: WebhookRoutesOptions,
): Promise<void> {
  const { db, tokenKey } = opts;

  // Capture the RAW bytes GitHub signed BEFORE JSON parsing (SC-3). Scoped to
  // this encapsulation only — the rest of the API keeps default parsing.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error);
    }
  });

  app.post('/webhooks/github', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'];
    const deliveryId = request.headers['x-github-delivery'];
    const event = request.headers['x-github-event'];
    const rawBody = request.rawBody;
    if (
      typeof signature !== 'string' ||
      typeof deliveryId !== 'string' ||
      typeof event !== 'string' ||
      !rawBody
    ) {
      return unauthorized(request, reply, opts);
    }

    const payload = request.body as GithubPayload;
    const repoFullName = payload.repository?.full_name;
    if (!repoFullName) return unauthorized(request, reply, opts);
    const [org, name] = repoFullName.split('/');

    // Find the repo → its connection → the sealed per-connection webhook secret.
    const [row] = await db
      .select({
        repoId: core.repos.id,
        workspaceId: core.repos.workspaceId,
        connectionId: core.repos.connectionId,
        sealed: core.forgeConnections.webhookSecretCiphertext,
      })
      .from(core.repos)
      .innerJoin(core.forgeConnections, eq(core.repos.connectionId, core.forgeConnections.id))
      .where(and(eq(core.repos.org, org ?? ''), eq(core.repos.name, name ?? '')))
      .limit(1);
    if (!row || !row.sealed) return unauthorized(request, reply, opts);

    // Verify the HMAC over the raw body (constant-time). Invalid ⇒ 401.
    let secret: string;
    try {
      secret = credentials.openSecret(row.sealed, tokenKey);
    } catch {
      return unauthorized(request, reply, opts);
    }
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      return unauthorized(request, reply, opts);
    }

    // Dedupe (SC-4): a GitHub redelivery of the same delivery_id is a no-op.
    const isNew = await recordDelivery(db, {
      workspaceId: row.workspaceId,
      connectionId: row.connectionId,
      deliveryId,
      event,
      action: payload.action ?? null,
      repoFullName,
      payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
    });
    if (!isNew) return reply.code(200).send({ status: 'duplicate' });

    // Route to a typed delta job (the payload is only a doorbell). Unsubscribed
    // events are accepted but do nothing.
    const kind = routeEvent(event);
    if (kind !== null) {
      await opts.enqueueDelta(
        deltaEnqueueSpec({
          workspaceId: row.workspaceId,
          repoId: row.repoId,
          repo: repoFullName,
          kind,
        }),
      );
    }
    return reply.code(202).send({ status: 'accepted' });
  });
}
