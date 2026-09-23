import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { verifyGitlabWebhookToken, verifyWebhookSignature } from '@repopulse/forge';
import {
  deltaEnqueueSpec,
  recordDelivery,
  routeEvent,
  routeGitlabEvent,
  type DeltaEnqueueSpec,
  type DeltaKind,
} from '@repopulse/ingest';
import { sendProblem } from '../../lib/problem.js';

// Webhook receiver (INGESTION §4, SC-3/SC-4, FR-INGEST-5/6). Machine-facing, no
// session (API_DESIGN §1 exempts /webhooks/*). Must answer <10s: verify the
// sender over the RAW body, dedupe on delivery_id, enqueue a typed delta job,
// respond 202. A tampered/absent signature ⇒ 401, nothing enqueued.
//
// Two routes, one pipeline (W17-36):
//   /webhooks/github — GitHub AND Gitea. Verified against a live Gitea 1.24.7
//     (docs/research/gitea-api.md): a `type: gitea` hook sends X-GitHub-Event,
//     X-GitHub-Delivery and X-Hub-Signature-256 `sha256=<hex>` alongside its own
//     X-Gitea-* headers, and repository.full_name in the body — so the GitHub
//     verifier accepts a genuine Gitea delivery unchanged.
//   /webhooks/gitlab — GitLab sends the shared secret itself in X-Gitlab-Token,
//     names events "Merge Request Hook", and puts the path in
//     project.path_with_namespace. Nothing about it fits the GitHub route.

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

interface GitlabPayload {
  object_attributes?: { action?: string };
  project?: { path_with_namespace?: string };
}

/** What one forge's delivery reduces to once its headers and body are read. */
interface Delivery {
  deliveryId: string;
  event: string;
  action: string | null;
  repoFullName: string;
  kind: DeltaKind | null;
  /** Does this candidate connection's secret authenticate the delivery? */
  verify: (secret: string) => boolean;
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

const header = (request: FastifyRequest, name: string): string | undefined => {
  const v = request.headers[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

export default async function webhookRoutes(
  app: FastifyInstance,
  opts: WebhookRoutesOptions,
): Promise<void> {
  const { db, tokenKey } = opts;

  // Capture the RAW bytes the forge signed BEFORE JSON parsing (SC-3). Scoped to
  // this encapsulation only — the rest of the API keeps default parsing.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error);
    }
  });

  /**
   * Resolve the repo, authenticate against ITS connection's sealed secret,
   * dedupe, enqueue. Every repo row with this path on a connection of an
   * accepted provider is a candidate: the same `org/name` can exist on two
   * forges, and the one whose secret verifies is the one that sent it.
   */
  async function receive(
    request: FastifyRequest,
    reply: FastifyReply,
    providers: string[],
    d: Delivery,
  ): Promise<FastifyReply> {
    const candidates = await db
      .select({
        repoId: core.repos.id,
        workspaceId: core.repos.workspaceId,
        connectionId: core.repos.connectionId,
        sealed: core.forgeConnections.webhookSecretCiphertext,
      })
      .from(core.repos)
      .innerJoin(core.forgeConnections, eq(core.repos.connectionId, core.forgeConnections.id))
      .where(
        and(
          sql`${core.repos.org} || '/' || ${core.repos.name} = ${d.repoFullName}`,
          inArray(core.forgeConnections.provider, providers),
        ),
      )
      .limit(10);

    const row = candidates.find((c) => {
      if (!c.sealed) return false;
      try {
        return d.verify(credentials.openSecret(c.sealed, tokenKey));
      } catch {
        return false;
      }
    });
    if (!row) return unauthorized(request, reply, opts);

    // Dedupe (SC-4): a redelivery of the same delivery_id is a no-op.
    const isNew = await recordDelivery(db, {
      workspaceId: row.workspaceId,
      connectionId: row.connectionId,
      deliveryId: d.deliveryId,
      event: d.event,
      action: d.action,
      repoFullName: d.repoFullName,
      payloadDigest: createHash('sha256')
        .update(request.rawBody ?? Buffer.alloc(0))
        .digest('hex'),
    });
    if (!isNew) return reply.code(200).send({ status: 'duplicate' });

    // Route to a typed delta job (the payload is only a doorbell). Unsubscribed
    // events are accepted but do nothing.
    if (d.kind !== null) {
      await opts.enqueueDelta(
        deltaEnqueueSpec({
          workspaceId: row.workspaceId,
          repoId: row.repoId,
          repo: d.repoFullName,
          kind: d.kind,
        }),
      );
    }
    return reply.code(202).send({ status: 'accepted' });
  }

  app.post('/webhooks/github', async (request, reply) => {
    const signature = header(request, 'x-hub-signature-256');
    const deliveryId = header(request, 'x-github-delivery');
    const event = header(request, 'x-github-event');
    const rawBody = request.rawBody;
    if (!signature || !deliveryId || !event || !rawBody) {
      return unauthorized(request, reply, opts);
    }
    const payload = request.body as GithubPayload;
    const repoFullName = payload.repository?.full_name;
    if (!repoFullName) return unauthorized(request, reply, opts);

    return receive(request, reply, ['github', 'gitea'], {
      deliveryId,
      event,
      action: payload.action ?? null,
      repoFullName,
      kind: routeEvent(event),
      verify: (secret) => verifyWebhookSignature(rawBody, signature, secret),
    });
  });

  app.post('/webhooks/gitlab', async (request, reply) => {
    const token = header(request, 'x-gitlab-token');
    const event = header(request, 'x-gitlab-event');
    // `webhook-id` / `Idempotency-Key` are stable across GitLab's retries
    // (17.4+/19.0+), which is what dedupe needs; X-Gitlab-Event-UUID is the
    // fallback on older instances (docs.gitlab.com webhooks, "Delivery headers").
    const deliveryId =
      header(request, 'webhook-id') ??
      header(request, 'idempotency-key') ??
      header(request, 'x-gitlab-event-uuid');
    if (!token || !event || !deliveryId || !request.rawBody) {
      return unauthorized(request, reply, opts);
    }
    const payload = request.body as GitlabPayload;
    const repoFullName = payload.project?.path_with_namespace;
    if (!repoFullName) return unauthorized(request, reply, opts);

    return receive(request, reply, ['gitlab'], {
      deliveryId,
      event,
      action: payload.object_attributes?.action ?? null,
      repoFullName,
      kind: routeGitlabEvent(event),
      verify: (secret) => verifyGitlabWebhookToken(token, secret),
    });
  });
}
