import { requestHeadersFor } from '../config/hosts.js';
import { chatCompletionsUrl, normalizeHost, type T2Host } from '../t2/client.js';

// Capability probe (W19-01).
//
// A connection that answers "hello" tells you nothing about whether it can run
// an analysis pass. The pass needs four things the probe checks for ONCE, when
// the connection is configured, and records on the connection row:
//
//   context window  how much of a diff chunk fits — read from the server's own
//                   model metadata where it publishes one, otherwise UNKNOWN.
//                   Never guessed: a made-up number would silently size chunks.
//   streaming       the T2 client streams every call (W16-39); a server that
//                   cannot stream cannot run a pass at all.
//   json mode       `response_format: json_object`. Findings are REQUIRED to be
//                   JSON; servers without it still work from the prompt alone,
//                   so this one is recorded, not fatal.
//   tool use        recorded for the specialist roles that will want it.
//
// Each capability is 'yes' | 'no' | 'unknown'. 'unknown' means the probe could
// not tell (timeout, a reasoning model that spent its budget thinking) and it
// is deliberately NOT collapsed into 'no' — a wrong "no" would block a working
// model at configuration time.

export type Tri = 'yes' | 'no' | 'unknown';

export interface Capabilities {
  /** Tokens, or null when the server does not publish it. */
  contextWindow: number | null;
  streaming: Tri;
  jsonMode: Tri;
  toolUse: Tri;
  /** One sentence per non-obvious result, shown in the admin UI. */
  notes: string[];
  probedAt: string;
}

/** Below this the findings schema plus a minimal diff chunk cannot fit. */
export const MIN_CONTEXT_WINDOW = 8192;

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Per-call ceiling; reasoning models are slow, so this is generous. */
  timeoutMs?: number;
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

interface ChatChoice {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: unknown[];
  };
  finish_reason?: string | null;
}

/**
 * The model ids the server says it can serve (W20-21, UX_TODO AI-20), from the
 * OpenAI-compatible `GET /v1/models` (LM Studio, Ollama, vLLM, LiteLLM, the
 * hosted gateways all answer it). Offered as a picker after Test so the admin
 * does not have to type an exact identifier. Empty when the server does not
 * answer it; never throws. A listing call, not a model call: nothing is sent
 * but the credential the connection already uses.
 */
export async function listModels(
  host: T2Host,
  deps: Pick<ProbeDeps, 'fetchImpl' | 'timeoutMs'> = {},
): Promise<string[]> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`${normalizeHost(host.baseUrl)}/v1/models`, {
      headers: requestHeadersFor(host.auth),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return [];
    const ids = body.data
      .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200);
    return [...new Set(ids)].sort().slice(0, 200);
  } catch {
    return [];
  }
}

export async function probeCapabilities(host: T2Host, deps: ProbeDeps = {}): Promise<Capabilities> {
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const headers = requestHeadersFor(host.auth);
  const notes: string[] = [];
  const url = chatCompletionsUrl(host);

  const post = (payload: Record<string, unknown>): Promise<Response> =>
    f(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: host.modelSlot, ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  // SEQUENTIAL, on purpose. Against a real LM Studio the first call loads the
  // model, and four requests arriving together while it loads came back as
  // HTTP 500s that read as "unsupported" — the probe's own concurrency was the
  // failure. One at a time, the same server answered every probe correctly.
  const contextWindow = await probeContextWindow(host, f, headers, timeoutMs);
  const streaming = await probeStreaming(post, notes);
  const jsonMode = await probeJsonMode(post, notes);
  const toolUse = await probeToolUse(post, notes);

  if (contextWindow === null) {
    notes.push(
      'The server does not publish a context window, so chunk sizing falls back to the global default.',
    );
  } else if (contextWindow < MIN_CONTEXT_WINDOW) {
    notes.push(
      `The context window is ${contextWindow} tokens; an analysis pass needs at least ${MIN_CONTEXT_WINDOW}.`,
    );
  }

  return {
    contextWindow,
    streaming,
    jsonMode,
    toolUse,
    notes,
    probedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

type Post = (payload: Record<string, unknown>) => Promise<Response>;

async function probeStreaming(post: Post, notes: string[]): Promise<Tri> {
  try {
    const res = await post({
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 64,
      temperature: 0,
      stream: true,
    });
    if (!res.ok || !res.body) {
      notes.push(`Streaming probe was refused (HTTP ${res.status}).`);
      return res.status === 400 || res.status === 422 ? 'no' : 'unknown';
    }
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    // A server that ignores `stream` answers one JSON body; a streaming one
    // sends `data:` event lines.
    if (/text\/event-stream/.test(ct) || /^data:/m.test(text)) return 'yes';
    notes.push('The server ignored `stream: true` and answered with a single body.');
    return 'no';
  } catch (err) {
    notes.push(`Streaming probe failed: ${describe(err)}.`);
    return 'unknown';
  }
}

const JSON_SCHEMA_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'probe',
    strict: true,
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
};

/**
 * Tries the two response formats servers actually implement. OpenAI-style
 * servers take `json_object`; LM Studio refuses it ("must be 'json_schema' or
 * 'text'") and takes `json_schema` — found by probing the real server, which is
 * why this tries both rather than assuming one. A reasoning model may put the
 * answer in `reasoning_content`, so both fields are read.
 */
async function probeJsonMode(post: Post, notes: string[]): Promise<Tri> {
  const formats: [string, Record<string, unknown>][] = [
    ['json_object', { type: 'json_object' }],
    ['json_schema', JSON_SCHEMA_FORMAT],
  ];
  let definite = 0;
  for (const [name, response_format] of formats) {
    try {
      const res = await post({
        messages: [
          { role: 'user', content: 'Return a JSON object with one key "ok" whose value is true.' },
        ],
        max_tokens: 1024,
        temperature: 0,
        response_format,
      });
      if (!res.ok) {
        // Servers disagree on the status for an unsupported format (OpenAI 400,
        // LM Studio 500), so only a body naming response_format is definite.
        const text = await res.text().catch(() => '');
        if (res.status === 400 || res.status === 422 || /response_format/.test(text)) definite++;
        continue;
      }
      const choice = firstChoice(await res.json());
      const content =
        `${choice?.message?.content ?? ''}`.trim() ||
        `${choice?.message?.reasoning_content ?? ''}`.trim();
      if (content === '') continue;
      try {
        JSON.parse(content);
        if (name === 'json_schema')
          notes.push('JSON mode works through `json_schema`, not `json_object`.');
        return 'yes';
      } catch {
        definite++;
      }
    } catch (err) {
      notes.push(`JSON-mode probe failed: ${describe(err)}.`);
      return 'unknown';
    }
  }
  if (definite === formats.length) {
    notes.push('The server refused both JSON response formats; findings rely on the prompt alone.');
    return 'no';
  }
  return 'unknown';
}

async function probeToolUse(post: Post, notes: string[]): Promise<Tri> {
  try {
    const res = await post({
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
      max_tokens: 1024,
      temperature: 0,
      tools: [WEATHER_TOOL],
      tool_choice: 'auto',
    });
    if (!res.ok) {
      notes.push(`Tool use was refused (HTTP ${res.status}).`);
      return res.status === 400 || res.status === 422 ? 'no' : 'unknown';
    }
    const choice = firstChoice(await res.json());
    if ((choice?.message?.tool_calls?.length ?? 0) > 0) return 'yes';
    // The server accepted `tools` but the model answered in prose: it may
    // support tool calls and have declined, which a single probe cannot settle.
    return 'unknown';
  } catch (err) {
    notes.push(`Tool-use probe failed: ${describe(err)}.`);
    return 'unknown';
  }
}

/**
 * Looks for the context length where servers actually publish it. None of these
 * is standard; each is a documented field of a specific server's model listing.
 *   LM Studio  GET /api/v0/models/{id}  → max_context_length / loaded_context_length
 *   vLLM       GET /v1/models           → data[].max_model_len
 *   LiteLLM    GET /v1/models           → data[].max_input_tokens (when set)
 *   Ollama     POST /api/show           → model_info["<arch>.context_length"]
 */
async function probeContextWindow(
  host: T2Host,
  f: typeof fetch,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<number | null> {
  const origin = normalizeHost(host.baseUrl);
  const get = async (path: string): Promise<unknown> => {
    try {
      const res = await f(`${origin}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  const lm = (await get(`/api/v0/models/${encodeURIComponent(host.modelSlot)}`)) as Record<
    string,
    unknown
  > | null;
  const lmCtx = num(lm?.loaded_context_length) ?? num(lm?.max_context_length);
  if (lmCtx !== null) return lmCtx;

  const list = (await get('/v1/models')) as { data?: Record<string, unknown>[] } | null;
  const entry = list?.data?.find((m) => m.id === host.modelSlot);
  const listed =
    num(entry?.max_model_len) ??
    num(entry?.context_length) ??
    num(entry?.context_window) ??
    num(entry?.max_input_tokens);
  if (listed !== null) return listed;

  try {
    const res = await f(`${origin}/api/show`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: host.modelSlot }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info;
      for (const [k, v] of Object.entries(info ?? {})) {
        if (k.endsWith('.context_length')) {
          const n = num(v);
          if (n !== null) return n;
        }
      }
    }
  } catch {
    /* not an Ollama server */
  }
  return null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;

const firstChoice = (body: unknown): ChatChoice | undefined =>
  (body as { choices?: ChatChoice[] }).choices?.[0];

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Turns a probe into the sentences that block a configuration (W19-01). Only
 * what makes a scheduled pass impossible is fatal; everything else is returned
 * as a note the UI shows next to the result.
 */
export function capabilityProblems(c: Capabilities): string[] {
  const problems: string[] = [];
  if (c.streaming === 'no') {
    problems.push(
      'This server does not stream responses, and every analysis call is streamed — choose a server or model that supports `stream: true`.',
    );
  }
  if (c.contextWindow !== null && c.contextWindow < MIN_CONTEXT_WINDOW) {
    problems.push(
      `This model's context window is ${c.contextWindow} tokens; an analysis pass needs at least ${MIN_CONTEXT_WINDOW}. Raise the loaded context length or pick a larger model.`,
    );
  }
  return problems;
}
