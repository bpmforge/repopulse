import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, type Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';
import { decodePrCursor, prFindings, SEVERITY_LABELS } from './new-findings.js';

// Customer-CI pull (W18-18, D16): the customer's CI asks "what is new on this
// PR?" and acts on the answer with its own forge token. RepoPulse only answers.
// It never posts a status, a check or a comment (D9a, N-3), and nothing here
// imports @repopulse/forge — the answer comes from the warehouse (Law 4).
//
// Both routes accept a session (the UI may use the same answer) OR a CI token
// carrying `pr_findings:read`, and they are the ONLY routes that accept one.

export interface PullsRoutesOptions {
  db: Database;
  /** Where the CLI file is read from. Injectable for the test. */
  cliPath?: string;
}

const CI_READ = { ciToken: { scope: 'pr_findings:read' as const } };
// SC-11-style ceiling for a machine caller. Generous for CI (a pipeline asks a
// handful of times per push, a few hundred while it polls for a scan) and
// still a ceiling on a script stuck in a loop.
const CI_RATE_LIMIT = { max: 300, timeWindow: '1 minute' };

const params = z.object({
  id: z.coerce.number().int().positive(),
  number: z.coerce.number().int().positive(),
});

// 'true' | 'false' rather than z.coerce.boolean(): coerce turns the string
// "false" into true, which on a flag that widens a CI gate is the wrong way to
// be surprised.
const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const query = z.object({
  new: flag('true'),
  include_experimental: flag('false'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const item = z.object({
  id: z.number(),
  rule_id: z.string().nullable(),
  scanner_key: z.string().nullable(),
  dimension: z.string(),
  severity: z.number().int().min(1).max(5),
  severity_label: z.enum(SEVERITY_LABELS),
  confidence: z.number().int().min(1).max(5),
  title: z.string(),
  file: z.string().nullable(),
  line_start: z.number().nullable(),
  line_end: z.number().nullable(),
  evidence: z.string(),
  suggested_fix: z.string(),
  experimental: z.boolean(),
  status: z.string(),
  introduced_by_pr: z.boolean(),
  seen_at_head: z.boolean(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

const response = z.object({
  pull: z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    head_sha: z.string(),
    base_ref: z.string(),
  }),
  head: z.object({
    sha: z.string(),
    scanned: z.boolean(),
    scanners: z.array(z.object({ scanner_key: z.string(), scanned_at: z.string() })),
    pending: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  items: z.array(item),
  next_cursor: z.string().nullable(),
});

/**
 * The problem type for "this PR has not been ingested yet" (W20-15, UX_TODO
 * X-14). The CLI keeps waiting on it; any other 404 (a token that does not
 * name the repository, an unknown repository) is a real refusal.
 */
export const PR_NOT_SYNCED_PROBLEM = 'urn:repopulse:problem:pr-not-synced';

const DEFAULT_CLI_PATH = new URL(
  '../../../../../tools/repopulse-cli/repopulse.mjs',
  import.meta.url,
);

export default async function pullsRoutes(
  app: FastifyInstance,
  opts: PullsRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/repos/:id/pulls/:number/findings',
    {
      config: { ...CI_READ, rateLimit: CI_RATE_LIMIT },
      schema: { params, querystring: query, response: { 200: response } },
    },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) {
        sendProblem(request, reply, 401, 'No active session');
        return reply;
      }
      const { id: repoId, number } = request.params;

      // A token reads only the repositories it was minted for. 404, not 403:
      // the answer to "may I read repo 7?" must not double as "repo 7 exists".
      if (request.ciToken && !request.ciToken.repoIds.includes(repoId)) {
        sendProblem(request, reply, 404, 'Not Found');
        return reply;
      }
      const [repo] = await db
        .select({ id: core.repos.id })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      if (!repo) {
        sendProblem(request, reply, 404, 'Not Found');
        return reply;
      }

      let cursor: { severity: number; id: number } | null = null;
      if (request.query.cursor !== undefined) {
        cursor = decodePrCursor(request.query.cursor);
        if (!cursor) {
          sendProblem(request, reply, 400, 'Invalid cursor');
          return reply;
        }
      }

      const result = await prFindings(db, {
        workspaceId,
        repoId,
        prNumber: number,
        newOnly: request.query.new,
        includeExperimental: request.query.include_experimental,
        cursor,
        limit: request.query.limit,
      });
      if (!result) {
        // Most often: the CI asked before the webhook for this PR was ingested.
        sendProblem(request, reply, 404, 'Pull request not found', {
          type: PR_NOT_SYNCED_PROBLEM,
          detail: `RepoPulse has no pull request #${number} for repository ${repoId} yet. If it was just opened, retry once its webhook has been processed.`,
        });
        return reply;
      }
      return reply.send(result);
    },
  );

  // The CLI itself, so a pipeline can fetch the version that matches this
  // server with the token it already holds — nothing is published publicly
  // (D10), and a self-hosted install has no package registry to pull from.
  app.get(
    '/cli/repopulse.mjs',
    { config: { ...CI_READ, rateLimit: CI_RATE_LIMIT } },
    async (request, reply) => {
      let body: string;
      try {
        body = await readFile(opts.cliPath ?? DEFAULT_CLI_PATH, 'utf8');
      } catch {
        sendProblem(request, reply, 404, 'The CLI is not bundled with this install');
        return reply;
      }
      return reply.type('text/javascript; charset=utf-8').send(body);
    },
  );
}
