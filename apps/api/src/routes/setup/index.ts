import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { oidc } from '@repopulse/auth';
import { core, security, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { ENV_REGISTRY, validateEnv } from './env-registry.js';

// Setup status (W11-02, E1.2; reframed by W15-05 for D14).
//
// What this is FOR: an operator has the stack running and needs to know which
// of the remaining steps is not done yet. It is deliberately not a pre-boot
// wizard: the variables the app cannot run without are checked at STARTUP and
// named there, because a half-booted app serving a friendly setup page is a
// worse failure than one that refuses to start.
//
// WHAT CHANGED IN W15-05. This list used to read as though a forge connection
// were a precondition for having a working install — every row was weighed
// equally into `ready`, so an operator who had signed in and was looking at
// the product was told it was not set up. Since D14 you sign in with a local
// account and a forge App is something you add when you want repository data,
// not something you register before you can get in. Two rows therefore carry
// `blocking: false`: they are what stands between you and REAL DATA, not
// between you and a usable install.
//
// IT NEVER RETURNS A VALUE. Only whether something is set, and what breaks if
// it is wrong. A setup screen that echoes secrets back is a credential leak
// wearing a helpful face.

export interface SetupRoutesOptions {
  db: Database;
}

export interface SetupCheck {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'unknown';
  detail: string;
  /** Where the operator goes to fix it. */
  docs: string;
  /**
   * Whether `ready` is allowed to hinge on this row. False means "you can sign
   * in and use the product without it" — it gates data, not the install.
   */
  blocking: boolean;
  /**
   * The in-app place to do it (W20-17, UX_TODO INS-21): a web route, so the
   * row offers "Open Connections" rather than only a markdown file.
   */
  action?: { label: string; to: string } | null;
}

/**
 * W20-17 (UX_TODO INS-20): INSTALL says to remove ADMIN_PASSWORD from .env
 * once the first admin has signed in. Pure, for its test. Never echoes it.
 */
export function adminPasswordCheck(env: NodeJS.ProcessEnv): SetupCheck {
  const present = Boolean(env.ADMIN_PASSWORD);
  return {
    id: 'admin_password',
    label: 'First admin password removed from .env',
    status: present ? 'missing' : 'ok',
    detail: present
      ? 'ADMIN_PASSWORD is still set in deploy/.env. It was only needed to create the first admin; that admin has signed in and chosen a new password, so delete the line (and any deploy/admin-password file) and restart the api. The stored account keeps working.'
      : 'ADMIN_PASSWORD is not set, as it should be after the first sign-in.',
    docs: 'docs/INSTALL.md#sign-in',
    blocking: false,
    action: null,
  };
}

/**
 * Which sign-in doors this deployment actually offers (D14, FR-AUTH-*).
 *
 * Pure and exported so it can be tested without a database: the whole point of
 * the row is what it says on an install that has no forge and no IdP, which is
 * exactly the install that has the least infrastructure to test against.
 *
 * It can never report a fault. Local password accounts are always registered,
 * so there is always at least one way in — and saying so IS the content here.
 * The row exists because the old checklist implied the opposite, and an
 * operator who believes they need a GitHub App before they can log in will go
 * and register one.
 */
export function authProvidersCheck(env: NodeJS.ProcessEnv): SetupCheck {
  const doors = ['local password accounts'];

  // Asked of the same function the server boots from rather than re-derived
  // from variable names here, so the checklist cannot claim SSO is live on a
  // configuration the app would not have accepted. A half-configured IdP
  // cannot reach this code: it throws at boot.
  const oidcConfig = oidc.oidcConfigFromEnv(env);
  if (oidcConfig) doors.push(`OIDC (${oidcConfig.displayName})`);

  const github = Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
  if (github) doors.push('GitHub sign-in');

  return {
    id: 'auth',
    label: 'Sign-in',
    status: 'ok',
    detail:
      `Live: ${doors.join(', ')}. ` +
      (github
        ? 'A forge App is not required to sign in — it is what lets people use their forge account instead of a password.'
        : 'No forge App is configured, and none is needed to sign in. Everyone signs in with an account created here.'),
    docs: 'docs/INSTALL.md#sign-in',
    blocking: true,
    action: { label: 'Open Members', to: '/admin/members' },
  };
}

function problem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(request, reply, status, title, {});
  return reply;
}

export default async function setupRoutes(
  app: FastifyInstance,
  opts: SetupRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /setup/status — what is still missing, admin only. */
  app.get('/setup/status', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');

    const checks: SetupCheck[] = [authProvidersCheck(process.env)];

    // Optional-but-important variables. The required ones cannot be missing —
    // the process would not have started — so listing them here as "ok" would
    // be theatre; they are reported as a single verified line instead.
    const problems = validateEnv(process.env, ['api', 'shared']);
    checks.push({
      id: 'env',
      label: 'Environment variables',
      status: problems.length === 0 ? 'ok' : 'missing',
      detail:
        problems.length === 0
          ? `All required variables are set and well-formed (${ENV_REGISTRY.filter((e) => e.required).length} required, ${ENV_REGISTRY.length} documented).`
          : problems.map((p) => `${p.name} ${p.reason}`).join('; '),
      docs: 'docs/CONFIG.md',
      blocking: true,
      action: null,
    });

    const [connection] = await db
      .select({
        id: core.forgeConnections.id,
        provider: core.forgeConnections.provider,
        status: core.forgeConnections.status,
      })
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId))
      .limit(1);

    checks.push({
      id: 'forge_connection',
      label: 'Forge connection',
      status: connection ? 'ok' : 'missing',
      detail: connection
        ? `Connected to ${connection.provider} (status ${connection.status}).`
        : 'No forge connection yet — so there is nothing to measure, and every dashboard will be empty. It is not needed to sign in or to administer this install. In Settings → Connections, add an access token for your GitHub, GitLab or Gitea (a GitHub App is optional and only adds GitHub sign-in); RepoPulse never uses a shared App.',
      docs: 'docs/INSTALL.md#connect-your-forge',
      blocking: false,
      action: { label: 'Open Connections', to: '/admin' },
    });

    const [repoCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId));

    checks.push({
      id: 'repos',
      label: 'Tracked repositories',
      status: (repoCount?.count ?? 0) > 0 ? 'ok' : 'missing',
      detail:
        (repoCount?.count ?? 0) > 0
          ? `${repoCount!.count} repositories selected.`
          : 'No repositories selected yet. Nothing is ingested until you pick some.',
      docs: 'docs/INSTALL.md#select-repositories',
      blocking: false,
      action: { label: 'Choose repositories', to: '/admin' },
    });

    // Webhook delivery is a fact about the LAST delivery, not about config: a
    // secret can be perfectly set and the URL still unreachable from the forge.
    // 'unknown' is therefore a real state here rather than a failure.
    const [delivery] = await db
      .select({ receivedAt: core.webhookDelivery.receivedAt })
      .from(core.webhookDelivery)
      .where(eq(core.webhookDelivery.workspaceId, workspaceId))
      .orderBy(sql`${core.webhookDelivery.receivedAt} desc`)
      .limit(1);

    checks.push({
      id: 'webhook',
      label: 'Webhook deliveries',
      status: delivery ? 'ok' : 'unknown',
      detail: delivery
        ? `Last delivery received ${delivery.receivedAt.toISOString()}.`
        : 'No webhook delivery has arrived yet. That is expected before your first push — it is not proof the webhook is wrong, and not proof it is right.',
      docs: 'docs/INSTALL.md#webhooks',
      blocking: false,
      action: { label: 'Open Sync', to: '/admin/sync' },
    });

    // W20-17 (UX_TODO INS-20, INS-60): the scan steps INSTALL calls essential.
    // A succeeded scan run proves the scan runner answered and the scan data
    // was there; until one exists, a repository with no findings is
    // indistinguishable from one nothing has looked at.
    const [scans] = await db
      .select({
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`(count(*) filter (where ${security.scanRuns.status} = 'succeeded'))::int`,
      })
      .from(security.scanRuns)
      .where(eq(security.scanRuns.workspaceId, workspaceId));
    const [firstRepo] = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId))
      .orderBy(core.repos.id)
      .limit(1);
    const scanned = (scans?.succeeded ?? 0) > 0;
    checks.push({
      id: 'scans',
      label: 'Scan data synced and a first security scan run',
      status: scanned ? 'ok' : (scans?.total ?? 0) > 0 ? 'missing' : 'unknown',
      detail: scanned
        ? `${scans!.succeeded} scan runs have completed.`
        : (scans?.total ?? 0) > 0
          ? `${scans!.total} scan runs recorded and none completed. Run deploy/scan-db-sync.sh on the host (it downloads the vulnerability database and malicious-package feed), check that the scan-runner container is up, then run a scan from a repository's Security tab.`
          : 'No security scan has run yet; the full set runs weekly. Run deploy/scan-db-sync.sh on the host first, then start the first scan from a repository’s Security tab instead of waiting.',
      docs: 'docs/INSTALL.md#scan-data',
      blocking: false,
      action: firstRepo
        ? { label: 'Run the first scan', to: `/repos/${firstRepo.id}/security` }
        : null,
    });

    // Optional (INS-20): AI review needs a model; nothing else does.
    const [models] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(core.llmProviders)
      .where(eq(core.llmProviders.workspaceId, workspaceId));
    checks.push({
      id: 'model',
      label: 'AI model connected (optional)',
      status: (models?.count ?? 0) > 0 ? 'ok' : 'unknown',
      detail:
        (models?.count ?? 0) > 0
          ? `${models!.count} model connection${models!.count === 1 ? '' : 's'} configured.`
          : 'No model connected. Optional: delivery metrics, hotspots and the scanners all work without one; only AI review needs it.',
      docs: 'docs/INSTALL.md#connect-a-model-optional',
      blocking: false,
      action: { label: 'Open Models', to: '/admin/models' },
    });

    checks.push(adminPasswordCheck(process.env));

    // Only the blocking rows. Weighing all of them made this flag permanently
    // false: the webhook row reports 'unknown' until a delivery arrives, so
    // `every(status === 'ok')` could not be true on a correct install that had
    // simply not been pushed to yet. A readiness flag that is never true is
    // read once and then ignored, which is worse than not shipping one.
    return reply.send({
      ready: checks.every((check) => !check.blocking || check.status === 'ok'),
      checks,
    });
  });

  /** GET /setup/config — the documented variables, WITHOUT any values. */
  app.get('/setup/config', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');

    return reply.send({
      variables: ENV_REGISTRY.map((entry) => ({
        name: entry.name,
        scope: entry.scope,
        required: entry.required,
        purpose: entry.purpose,
        if_wrong: entry.ifWrong,
        default: entry.default ?? null,
        secret: entry.secret ?? false,
        // Whether it is SET, never what it is set to.
        set: Boolean(process.env[entry.name]),
      })),
    });
  });
}
