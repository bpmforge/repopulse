import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { auditLog, type Database } from '@repopulse/shared';
import {
  CLAUDE_CLI_STATEMENT_POINTS,
  CLAUDE_CLI_STATEMENT_SHA256,
  CLAUDE_CLI_STATEMENT_TITLE,
  CLAUDE_CLI_STATEMENT_VERSION,
  claudeCliStatus,
  type CliDeps,
} from '@repopulse/analysis';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';
import {
  activeAcceptance,
  recordAcceptance,
  revokeAcceptance,
} from '../../../lib/claude-cli-acceptance.js';
import { readWorkerHeartbeats } from '../../../workers/heartbeat.js';

// Admin → Models → the customer-supplied Claude Code CLI option (W19-08).
//
// OFF BY DEFAULT. An admin reads the statement and accepts THIS VERSION of it;
// the acceptance is a row (who, when, version, hash) and an audit event. The
// option is customer-supplied: the customer installs and signs in to the CLI
// themselves, and RepoPulse neither stores nor transmits the login.

export interface ClaudeCliRoutesOptions {
  db: Database;
  /** Injectable so tests need no real CLI. */
  cli?: CliDeps;
  /**
   * W20-16 (UX_TODO AI-73). Where worker heartbeats live: the worker publishes
   * its OWN CLI check there, and the worker is the container that runs the
   * CLI. Without one, only the api's check is reported.
   */
  redisUrl?: string;
  redis?: Redis;
}

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(req, reply, status, title, detail === undefined ? {} : { detail });
  return reply;
}

export default async function claudeCliRoutes(
  app: FastifyInstance,
  opts: ClaudeCliRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const redis =
    opts.redis ?? (opts.redisUrl ? new Redis(opts.redisUrl, { lazyConnect: true }) : null);
  if (redis && opts.redis === undefined) {
    redis.on('error', (err: Error) => app.log.warn({ err }, 'claude-cli redis error'));
    app.addHook('onClose', async () => {
      await redis.quit().catch(() => redis.disconnect());
    });
  }

  /** The newest worker's own CLI check, or null when no worker has reported one. */
  async function workerCli() {
    if (!redis) return null;
    const beats = await readWorkerHeartbeats(redis).catch(() => []);
    const st = beats.find((b) => b.claudeCli)?.claudeCli;
    return st
      ? {
          found: st.found,
          version: st.version,
          reportsLoggedIn: st.reportsLoggedIn,
          reason: st.reason,
          checked_at: st.checkedAt,
        }
      : null;
  }

  app.get(
    '/admin/llm-providers/claude-cli',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const accepted = await activeAcceptance(db, workspaceId);
      return reply.send({
        statement: {
          version: CLAUDE_CLI_STATEMENT_VERSION,
          sha256: CLAUDE_CLI_STATEMENT_SHA256,
          title: CLAUDE_CLI_STATEMENT_TITLE,
          points: CLAUDE_CLI_STATEMENT_POINTS,
        },
        accepted: accepted
          ? {
              by: accepted.acceptedByLogin,
              at: accepted.acceptedAt,
              version: accepted.statementVersion,
              // False when the wording has changed since: it must be accepted again.
              current: accepted.current,
            }
          : null,
        // Presence and the CLI's own opinion of its login. No model call, no token.
        // `cli` is the API container's own check (it also runs Test); with
        // the overlay the api mounts the same volume since W20-16.
        cli: await claudeCliStatus(opts.cli),
        // What the WORKER — which runs every pass — found (AI-73).
        worker_cli: await workerCli(),
      });
    },
  );

  app.post(
    '/admin/llm-providers/claude-cli/accept',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const body = (request.body ?? {}) as {
        accept?: unknown;
        statement_version?: unknown;
        statement_sha256?: unknown;
      };

      // The admin accepts the EXACT text they were shown: the version and hash in
      // the request must be the current ones, so a reworded statement can never be
      // accepted on behalf of an old click.
      if (body.accept !== true) {
        return fail(
          request,
          reply,
          400,
          'Acceptance must be explicit',
          'Send accept: true after reading the statement.',
        );
      }
      if (
        body.statement_version !== CLAUDE_CLI_STATEMENT_VERSION ||
        body.statement_sha256 !== CLAUDE_CLI_STATEMENT_SHA256
      ) {
        return fail(
          request,
          reply,
          409,
          'The statement has changed',
          'Reload the page and read the current statement before accepting.',
        );
      }
      const existing = await activeAcceptance(db, workspaceId);
      if (existing?.current) {
        return fail(
          request,
          reply,
          409,
          'Already accepted',
          `Accepted by ${existing.acceptedByLogin ?? 'an admin'} on ${existing.acceptedAt.toISOString().slice(0, 10)}.`,
        );
      }
      // An acceptance of an OLDER statement is replaced, not stacked.
      if (existing) await revokeAcceptance(db, workspaceId, userId);

      const id = await recordAcceptance(db, workspaceId, userId);
      auditLog(request.log, {
        event: 'llm_claude_cli.accepted',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: {
          acceptance_id: id,
          statement_version: CLAUDE_CLI_STATEMENT_VERSION,
          statement_sha256: CLAUDE_CLI_STATEMENT_SHA256,
        },
      });
      return reply.code(201).send({ id });
    },
  );

  app.post(
    '/admin/llm-providers/claude-cli/revoke',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const revoked = await revokeAcceptance(db, workspaceId, userId);
      if (!revoked)
        return fail(request, reply, 404, 'Nothing to revoke', 'The option is already off.');
      auditLog(request.log, {
        event: 'llm_claude_cli.revoked',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: { statement_version: CLAUDE_CLI_STATEMENT_VERSION },
      });
      return reply.code(204).send();
    },
  );
}
