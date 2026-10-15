import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, isConstraintViolation, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  PROVIDER_REGISTRY,
  ProviderConfigError,
  HostPolicyError,
  requestHeadersFor,
  resolveProvider,
  type LlmProviderKind,
} from '@repopulse/analysis';
import { requireAdmin } from '../../../lib/rbac.js';
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
      })),
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
    const baseUrl = str(body.base_url);
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

    // Resolve BEFORE writing: a row that cannot produce a callable host is a row
    // whose failure would surface on some future scheduled pass instead of on
    // the screen of the person who just created it.
    try {
      resolveProvider({
        id: 0,
        name,
        kind,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
        allowPublicHost: body.allow_public_host === true,
      });
    } catch (err) {
      if (err instanceof ProviderConfigError || err instanceof HostPolicyError) {
        return fail(request, reply, 400, 'This provider cannot be used', err.message);
      }
      throw err;
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

    return reply.code(201).send({ id: created?.id ?? null });
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

    let host;
    try {
      host = resolveProvider({
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

    const origin = host.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const started = Date.now();
    try {
      const res = await fetchImpl(`${origin}/v1/chat/completions`, {
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
      return reply.send({
        ok: true,
        latency_ms: Date.now() - started,
        // What the endpoint says it ran, which is not always what was asked for
        // — a gateway may silently route elsewhere, and the operator should see
        // that here rather than discover it in a finding's provenance.
        model: parsed.model ?? host.modelSlot,
        sample: (parsed.choices?.[0]?.message?.content ?? '').slice(0, 120),
      });
    } catch (err) {
      return reply.send({ ok: false, stage: 'transport', detail: transportDetail(err) });
    }
  });
}
