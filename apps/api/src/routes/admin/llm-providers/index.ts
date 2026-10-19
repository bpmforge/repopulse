import { existsSync } from 'node:fs';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, isConstraintViolation, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  PROVIDER_PRESETS,
  claudeCliStatus,
  runClaudeCli,
  type CliDeps,
  PROVIDER_REGISTRY,
  ProviderConfigError,
  HostPolicyError,
  capabilityProblems,
  chatCompletionsUrl,
  probeCapabilities,
  requestHeadersFor,
  resolveProviderAsync,
  type Capabilities,
  type LlmProviderKind,
  type T2Host,
} from '@repopulse/analysis';
import { requireAdmin } from '../../../lib/rbac.js';
import { isClaudeCliAccepted } from '../../../lib/claude-cli-acceptance.js';
import { describeEndpoint } from '../../../lib/llm-routing.js';
import { sendProblem } from '../../../lib/problem.js';

// Admin → Models (W16-07, D-LLM-1).
//
// The configuration surface the product did not have. Before this, every LLM
// setting was an environment variable, so "point RepoPulse at my own model"
// meant editing a file on the host and restarting the container — for a
// standalone product whose premise is that you bring your own model, that was
// the largest gap the end-user review found (F5).
//
// ADMIN-ONLY AND AUDITED, for the same reason Admin → Analysis is: a provider
// row decides where this workspace's DIFFS are sent. Adding one that names a
// public endpoint is a data-egress decision, not a preference, so it is
// recorded with an author the way a Tier-3 opt-in is.
//
// THE KEY IS WRITE-ONLY. It is never rendered back, on any route, in any shape
// — the list returns a fingerprint the way the forge connections list does.
// A settings screen that redisplays a secret is how a secret ends up in a
// screenshot, a bug report, or a support ticket.

export interface LlmProviderRoutesOptions {
  db: Database;
  tokenKey: Buffer;
  /** Injectable so the test can exercise the round trip without a model. */
  fetchImpl?: typeof fetch;
  /** Injectable so tests need no real Claude Code CLI (W19-08). */
  cli?: CliDeps;
  /**
   * Whether this server runs in a container (W20-06, UX_TODO AI-57). Injectable
   * for tests; detected from the marker files Docker and Podman write.
   */
  inContainer?: boolean;
}

/**
 * The plain-words reason a test to "localhost" failed in a container (W20-06,
 * UX_TODO AI-57): there, localhost is the container itself, so a model running
 * on the host machine is not at that address. Null when it does not apply.
 */
export function localhostHint(baseUrl: string | null, inContainer: boolean): string | null {
  if (!inContainer || !baseUrl) return null;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return null;
  return 'RepoPulse runs in a container, so "localhost" here means the container itself, not the machine your model runs on. Use that machine\'s network address instead, such as http://192.168.1.50:1234/v1.';
}

interface ProviderBody {
  name?: unknown;
  kind?: unknown;
  base_url?: unknown;
  model?: unknown;
  api_key?: unknown;
  headers?: unknown;
  allow_public_host?: unknown;
  enabled?: unknown;
  /** Run the capability probe and store the result (W19-01). */
  probe?: unknown;
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

/**
 * Node's fetch reports every transport failure as the string "fetch failed" and
 * hides the real one in `error.cause` — so a refused connection, a DNS miss, a
 * TLS failure and a timeout all arrive looking identical. Found by pressing
 * Test against a LAN host that was switched off: the screen said "Could not
 * connect. fetch failed", which is the same uninformative sentence this button
 * exists to avoid.
 */
function transportDetail(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: string }).code;
    parts.push(code ? `${current.message} (${code})` : current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (parts.length === 0) return String(err);
  // Outermost first, then what actually went wrong underneath it.
  return parts.join(' — ');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Validates the headers bag.
 *
 * Rejects rather than sanitises: the `headers` column is NOT encrypted, so a
 * person putting a credential there has stored a secret in the clear. Dropping
 * it quietly would leave them believing it was both sent and safe.
 */
function parseHeaders(v: unknown): Record<string, string> | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return 'invalid';
    if (['authorization', 'x-api-key'].includes(k.toLowerCase())) return 'invalid';
    out[k] = val;
  }
  return out;
}

export default async function llmProviderRoutes(
  app: FastifyInstance,
  opts: LlmProviderRoutesOptions,
): Promise<void> {
  const { db, tokenKey } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const inContainer =
    opts.inContainer ?? (existsSync('/.dockerenv') || existsSync('/run/.containerenv'));

  /** The catalogue the UI renders its form from — one source for both. */
  app.get('/admin/llm-providers/kinds', { preHandler: requireAdmin }, async (_request, reply) => {
    return reply.send({
      kinds: Object.values(PROVIDER_REGISTRY).map((s) => ({
        kind: s.kind,
        label: s.label,
        auth_class: s.authClass,
        needs_base_url: s.needsBaseUrl,
        supported: s.supported,
        unsupported_reason: s.unsupportedReason ?? null,
        examples: s.examples ?? [],
        // W19-08: shown as customer-supplied, never as a RepoPulse feature, and
        // unusable until an admin accepts the statement.
        customer_supplied: s.customerSupplied === true,
        requires_acceptance: s.requiresAcceptance === true,
      })),
      presets: PROVIDER_PRESETS,
      // W20-06 (UX_TODO AI-57): the presets' localhost addresses cannot work
      // from inside a container, so the wizard needs to know which install it is.
      in_container: inContainer,
    });
  });

  app.get('/admin/llm-providers', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const rows = await db
      .select({
        id: core.llmProviders.id,
        name: core.llmProviders.name,
        kind: core.llmProviders.kind,
        baseUrl: core.llmProviders.baseUrl,
        model: core.llmProviders.model,
        fingerprint: core.llmProviders.credentialFingerprint,
        headers: core.llmProviders.headers,
        allowPublicHost: core.llmProviders.allowPublicHost,
        enabled: core.llmProviders.enabled,
        capabilities: core.llmProviders.capabilities,
        probedAt: core.llmProviders.probedAt,
        createdAt: core.llmProviders.createdAt,
      })
      .from(core.llmProviders)
      .where(eq(core.llmProviders.workspaceId, workspaceId))
      .orderBy(asc(core.llmProviders.name));

    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        base_url: r.baseUrl,
        model: r.model,
        // The fingerprint, never the key — same contract as a forge token.
        credential: r.fingerprint ? credentials.fingerprintLast4(r.fingerprint) : null,
        headers: r.headers ?? null,
        allow_public_host: r.allowPublicHost,
        enabled: r.enabled,
        capabilities: r.capabilities ?? null,
        probed_at: r.probedAt,
        // Where it sends, by the one definition the audit, local-only and the
        // host policy share: IP addresses on your network are home; a host NAME
        // is not (Brad, 2026-10-18).
        host: describeEndpoint(r.kind, r.baseUrl).host,
        leaves_network: describeEndpoint(r.kind, r.baseUrl).leavesNetwork,
        host_is_name: describeEndpoint(r.kind, r.baseUrl).hostIsName,
        created_at: r.createdAt,
      })),
    });
  });

  app.post('/admin/llm-providers', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session?.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }

    const body = (request.body ?? {}) as ProviderBody;
    const name = str(body.name);
    const kind = str(body.kind) as LlmProviderKind | null;
    const model = str(body.model);
    let baseUrl = str(body.base_url);
    const apiKey = str(body.api_key);
    const headers = parseHeaders(body.headers);

    if (!name) return fail(request, reply, 400, 'A name is required');
    if (!kind || !(kind in PROVIDER_REGISTRY)) {
      return fail(request, reply, 400, 'Unknown provider kind');
    }
    if (!model) return fail(request, reply, 400, 'A model id is required');
    if (headers === 'invalid') {
      return fail(
        request,
        reply,
        400,
        'Invalid headers',
        'Headers must be a flat object of strings, and must not carry a credential — put the key in the API key field, which is encrypted at rest.',
      );
    }

    const spec = PROVIDER_REGISTRY[kind];
    if (!spec.supported) {
      // Named at configuration time, not at call time inside a scheduled pass
      // nobody is watching.
      return fail(
        request,
        reply,
        400,
        `${spec.label} is not supported yet`,
        spec.unsupportedReason,
      );
    }

    // The customer-supplied CLI option (W19-08): off until an admin has accepted
    // the responsibility statement, and it holds no credential.
    let cliAccepted = false;
    if (kind === 'claude_cli') {
      baseUrl = null; // its endpoint is fixed; nothing the form said can change where it goes
      cliAccepted = await isClaudeCliAccepted(db, workspaceId);
      if (!cliAccepted) {
        return fail(
          request,
          reply,
          403,
          'The Claude Code CLI option is off',
          'An admin must read and accept the responsibility statement first (Admin → Models).',
        );
      }
      if (apiKey) {
        return fail(
          request,
          reply,
          400,
          'This option takes no API key',
          'The CLI keeps its own login and nothing is stored here. Use the Anthropic API-key provider for a key.',
        );
      }
    }

    // Resolve BEFORE writing: a row that cannot produce a callable host is a row
    // whose failure would surface on some future scheduled pass instead of on
    // the screen of the person who just created it.
    let resolved: T2Host;
    try {
      resolved = await resolveProviderAsync({
        id: 0,
        name,
        kind,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
        allowPublicHost: body.allow_public_host === true,
        cliAccepted,
      });
    } catch (err) {
      if (err instanceof ProviderConfigError || err instanceof HostPolicyError) {
        return fail(request, reply, 400, 'This provider cannot be used', err.message);
      }
      throw err;
    }

    // Capability probe (W19-01): refuse a model that cannot run a pass HERE,
    // with a sentence, rather than inside a scheduled one.
    let probed: Capabilities | null = null;
    // The CLI is not an HTTP chat endpoint: the HTTP probe does not apply to it.
    if (body.probe === true && kind !== 'claude_cli') {
      probed = await probeCapabilities(resolved, { fetchImpl });
      const problems = capabilityProblems(probed);
      if (problems.length > 0) {
        return fail(
          request,
          reply,
          422,
          'This model cannot run an analysis pass',
          problems.join(' '),
        );
      }
    }

    const enc = apiKey ? credentials.encryptCredential(apiKey, tokenKey) : null;

    let created;
    try {
      [created] = await db
        .insert(core.llmProviders)
        .values({
          workspaceId,
          name,
          kind,
          baseUrl,
          model,
          ...(enc
            ? {
                credentialCiphertext: enc.ciphertext,
                credentialIv: enc.iv,
                keyVersion: enc.keyVersion,
                credentialFingerprint: enc.fingerprint,
              }
            : {}),
          ...(headers ? { headers } : {}),
          allowPublicHost: body.allow_public_host === true,
          enabled: body.enabled !== false,
          ...(probed
            ? {
                capabilities: probed as unknown as Record<string, unknown>,
                probedAt: new Date(probed.probedAt),
              }
            : {}),
          createdBy: userId,
        })
        .returning({ id: core.llmProviders.id });
    } catch (err) {
      // The unique (workspace_id, name) index. Two providers with one label make
      // both the picker and the egress audit unreadable.
      if (isConstraintViolation(err, 'llm_providers_workspace_name_key')) {
        return fail(request, reply, 409, 'A provider with that name already exists');
      }
      throw err;
    }

    // Audited like a Tier-3 opt-in: this decides where diffs go.
    auditLog(request.log, {
      event: 'llm_provider.created',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      detail: {
        provider: name,
        kind,
        base_url: baseUrl,
        model,
        allow_public_host: body.allow_public_host === true,
        has_credential: enc !== null,
      },
    });

    return reply.code(201).send({ id: created?.id ?? null, capabilities: probed });
  });

  app.delete('/admin/llm-providers/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session?.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id)) return fail(request, reply, 400, 'Invalid id');

    const [gone] = await db
      .delete(core.llmProviders)
      // Workspace-filtered, not id-only: the tenancy invariant applies to a
      // delete exactly as much as to a read.
      .where(and(eq(core.llmProviders.id, id), eq(core.llmProviders.workspaceId, workspaceId)))
      .returning({ name: core.llmProviders.name });

    if (!gone) return fail(request, reply, 404, 'No such provider');

    auditLog(request.log, {
      event: 'llm_provider.deleted',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      detail: { provider: gone.name },
    });

    return reply.code(204).send();
  });

  /**
   * Edit or switch off a saved connection (W20-06, UX_TODO AI-03).
   *
   * Before this a connection could only be added, tested or deleted, so fixing a
   * typo'd model or rotating a key meant deleting it — which cascades it out of
   * every routing chain — and adding it again. Absent fields are left as they
   * are; `api_key` replaces the stored key (it is still never returned).
   *
   * An edit that leaves the connection ENABLED is resolved before it is written,
   * exactly as a create is: a connection that cannot produce a callable host
   * fails here, on the screen of the person editing it, not in a scheduled pass.
   */
  app.patch('/admin/llm-providers/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session?.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid id');

    // Workspace-filtered (Law 5): another workspace's connection is a 404.
    const [row] = await db
      .select()
      .from(core.llmProviders)
      .where(and(eq(core.llmProviders.id, id), eq(core.llmProviders.workspaceId, workspaceId)))
      .limit(1);
    if (!row) return fail(request, reply, 404, 'No such provider');

    const body = (request.body ?? {}) as ProviderBody;
    const isCli = row.kind === 'claude_cli';
    if (body.name !== undefined && !str(body.name)) {
      return fail(request, reply, 400, 'A name is required');
    }
    if (body.model !== undefined && !str(body.model)) {
      return fail(request, reply, 400, 'A model id is required');
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return fail(request, reply, 400, 'enabled must be true or false');
    }
    if (body.allow_public_host !== undefined && typeof body.allow_public_host !== 'boolean') {
      return fail(request, reply, 400, 'allow_public_host must be true or false');
    }
    if (isCli && (str(body.api_key) || body.base_url !== undefined)) {
      return fail(
        request,
        reply,
        400,
        'This option takes no API key or address',
        'The Claude Code CLI keeps its own login and has a fixed destination.',
      );
    }

    const name = str(body.name) ?? row.name;
    const model = str(body.model) ?? row.model;
    const baseUrl = body.base_url !== undefined ? str(body.base_url) : row.baseUrl;
    const newKey = str(body.api_key);
    const allowPublicHost =
      typeof body.allow_public_host === 'boolean' ? body.allow_public_host : row.allowPublicHost;
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : row.enabled;

    if (enabled) {
      const apiKey =
        newKey ??
        (row.credentialCiphertext && row.credentialIv && row.keyVersion !== null
          ? credentials.decryptCredential(
              {
                ciphertext: row.credentialCiphertext,
                iv: row.credentialIv,
                keyVersion: row.keyVersion,
              },
              tokenKey,
            )
          : null);
      try {
        await resolveProviderAsync({
          id: row.id,
          name,
          kind: row.kind as LlmProviderKind,
          baseUrl,
          model,
          ...(apiKey ? { apiKey } : {}),
          ...(row.headers ? { headers: row.headers as Record<string, string> } : {}),
          allowPublicHost,
          cliAccepted: isCli ? await isClaudeCliAccepted(db, workspaceId) : false,
        });
      } catch (err) {
        if (err instanceof ProviderConfigError || err instanceof HostPolicyError) {
          return fail(request, reply, 400, 'This provider cannot be used', err.message);
        }
        throw err;
      }
    }

    const enc = newKey ? credentials.encryptCredential(newKey, tokenKey) : null;
    try {
      await db
        .update(core.llmProviders)
        .set({
          name,
          model,
          baseUrl,
          allowPublicHost,
          enabled,
          ...(enc
            ? {
                credentialCiphertext: enc.ciphertext,
                credentialIv: enc.iv,
                keyVersion: enc.keyVersion,
                credentialFingerprint: enc.fingerprint,
              }
            : {}),
          // A probe describes the model it ran against; a new model or address
          // makes it stale, so it is cleared rather than left to mislead.
          ...(model !== row.model || baseUrl !== row.baseUrl
            ? { capabilities: null, probedAt: null }
            : {}),
        })
        .where(and(eq(core.llmProviders.id, id), eq(core.llmProviders.workspaceId, workspaceId)));
    } catch (err) {
      if (isConstraintViolation(err, 'llm_providers_workspace_name_key')) {
        return fail(request, reply, 409, 'A provider with that name already exists');
      }
      throw err;
    }

    // The roles whose chains name it, so switching it off can say what changes.
    const routes = await db
      .select({ role: core.llmRoleRoutes.role })
      .from(core.llmRoleRoutes)
      .where(
        and(eq(core.llmRoleRoutes.workspaceId, workspaceId), eq(core.llmRoleRoutes.providerId, id)),
      );

    // Audited like a create: this can change where diffs go. Never the key.
    auditLog(request.log, {
      event: 'llm_provider.updated',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      detail: {
        provider: name,
        kind: row.kind,
        base_url: baseUrl,
        model,
        allow_public_host: allowPublicHost,
        enabled,
        key_rotated: enc !== null,
      },
    });

    return reply.send({
      id,
      enabled,
      routed_roles: [...new Set(routes.map((r) => r.role))].sort(),
    });
  });

  /**
   * A REAL round trip, before anything is saved.
   *
   * The failure this exists to prevent: a provider that looks configured, and
   * whose first actual use is a scheduled pass at 02:41 that skips with a
   * message nobody reads. The response deliberately carries the endpoint's own
   * error text — "model not found", "invalid api key", a connection refusal are
   * three different problems with three different fixes, and collapsing them
   * into "connection failed" makes the button worthless.
   */
  app.post('/admin/llm-providers/test', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const body = (request.body ?? {}) as ProviderBody & { id?: unknown };
    let name = str(body.name) ?? 'test';
    let kind = str(body.kind) as LlmProviderKind | null;
    let baseUrl = str(body.base_url);
    let model = str(body.model);
    let apiKey = str(body.api_key);
    let headers = parseHeaders(body.headers);
    let allowPublicHost = body.allow_public_host === true;

    // Testing a SAVED provider: the key is not in the request (it is never sent
    // to the browser), so it comes from the vault.
    if (typeof body.id === 'number') {
      const [row] = await db
        .select()
        .from(core.llmProviders)
        .where(
          and(eq(core.llmProviders.id, body.id), eq(core.llmProviders.workspaceId, workspaceId)),
        )
        .limit(1);
      if (!row) return fail(request, reply, 404, 'No such provider');
      name = row.name;
      kind = row.kind as LlmProviderKind;
      baseUrl = row.baseUrl;
      model = row.model;
      headers = (row.headers ?? null) as Record<string, string> | null;
      allowPublicHost = row.allowPublicHost;
      apiKey =
        row.credentialCiphertext && row.credentialIv && row.keyVersion !== null
          ? credentials.decryptCredential(
              {
                ciphertext: row.credentialCiphertext,
                iv: row.credentialIv,
                keyVersion: row.keyVersion,
              },
              tokenKey,
            )
          : null;
    }

    if (!kind || !(kind in PROVIDER_REGISTRY) || !model) {
      return fail(request, reply, 400, 'A kind and a model are required');
    }
    if (headers === 'invalid') return fail(request, reply, 400, 'Invalid headers');

    // The customer-supplied CLI (W19-08) is not an HTTP endpoint: Test runs the
    // customer's own CLI once, and reports its own words if it cannot.
    if (kind === 'claude_cli') {
      if (!(await isClaudeCliAccepted(db, workspaceId))) {
        return reply.send({
          ok: false,
          stage: 'config',
          detail:
            'The Claude Code CLI option is off: an admin must read and accept the responsibility statement first.',
        });
      }
      const started = Date.now();
      try {
        const status = await claudeCliStatus(opts.cli);
        if (!status.found) return reply.send({ ok: false, stage: 'config', detail: status.reason });
        const r = await runClaudeCli('Reply with the single word: ok', model, opts.cli);
        return reply.send({
          ok: true,
          latency_ms: Date.now() - started,
          model: r.model,
          sample: r.text.slice(0, 120),
        });
      } catch (err) {
        return reply.send({
          ok: false,
          stage: 'transport',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let host: T2Host;
    try {
      host = await resolveProviderAsync({
        id: 0,
        name,
        kind,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
        allowPublicHost,
      });
    } catch (err) {
      if (err instanceof ProviderConfigError || err instanceof HostPolicyError) {
        return reply.send({ ok: false, stage: 'config', detail: err.message });
      }
      throw err;
    }

    const started = Date.now();
    try {
      const res = await fetchImpl(chatCompletionsUrl(host), {
        method: 'POST',
        headers: requestHeadersFor(host.auth),
        body: JSON.stringify({
          model: host.modelSlot,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          // Small on purpose: this is a reachability and credential check, not
          // a capability test, and a test button should not cost real money.
          max_tokens: 16,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      if (!res.ok) {
        return reply.send({
          ok: false,
          stage: 'response',
          status: res.status,
          // The endpoint's own words, truncated. "Invalid API key" and "model
          // not found" need different fixes.
          detail: text.slice(0, 400),
        });
      }

      const parsed = JSON.parse(text) as {
        choices?: { message?: { content?: string } }[];
        model?: string;
      };
      let capabilities: Capabilities | null = null;
      if (body.probe === true) {
        capabilities = await probeCapabilities(host, { fetchImpl });
        if (typeof body.id === 'number') {
          await db
            .update(core.llmProviders)
            .set({
              capabilities: capabilities as unknown as Record<string, unknown>,
              probedAt: new Date(capabilities.probedAt),
            })
            .where(
              and(
                eq(core.llmProviders.id, body.id),
                eq(core.llmProviders.workspaceId, workspaceId),
              ),
            );
        }
      }
      return reply.send({
        ok: true,
        ...(capabilities ? { capabilities, problems: capabilityProblems(capabilities) } : {}),
        latency_ms: Date.now() - started,
        // What the endpoint says it ran, which is not always what was asked for
        // — a gateway may silently route elsewhere, and the operator should see
        // that here rather than discover it in a finding's provenance.
        model: parsed.model ?? host.modelSlot,
        sample: (parsed.choices?.[0]?.message?.content ?? '').slice(0, 120),
      });
    } catch (err) {
      const hint = localhostHint(baseUrl, inContainer);
      return reply.send({
        ok: false,
        stage: 'transport',
        detail: transportDetail(err),
        ...(hint ? { hint } : {}),
      });
    }
  });
}
