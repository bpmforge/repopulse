import { describe, expect, it } from 'vitest';
import { capabilityProblems, probeCapabilities, type Capabilities } from './probe.js';

type Handler = (url: string, body: Record<string, unknown> | null) => Response | undefined;

function server(handle: Handler): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    return handle(String(url), body) ?? new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const sse = () =>
  new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
const reply = (content: string, extra: Record<string, unknown> = {}) =>
  json({ choices: [{ message: { content, ...extra } }] });

const host = { baseUrl: 'http://localhost:1234/v1', modelSlot: 'm' };
const now = () => new Date('2026-10-17T00:00:00Z');

describe('probeCapabilities', () => {
  it('records a fully capable OpenAI-style server (vLLM publishes max_model_len)', async () => {
    const f = server((url, body) => {
      if (url.endsWith('/v1/models')) return json({ data: [{ id: 'm', max_model_len: 32768 }] });
      if (!url.endsWith('/chat/completions') || !body) return undefined;
      if (body.stream) return sse();
      if (body.tools) return reply('', { tool_calls: [{ id: '1' }] });
      return reply('{"ok":true}');
    });
    expect(await probeCapabilities(host, { fetchImpl: f, now })).toEqual({
      contextWindow: 32768,
      streaming: 'yes',
      jsonMode: 'yes',
      toolUse: 'yes',
      notes: [],
      probedAt: '2026-10-17T00:00:00.000Z',
    });
  });

  it('falls back to json_schema when json_object is refused (LM Studio) and reads LM Studio context', async () => {
    const f = server((url, body) => {
      if (url.includes('/api/v0/models/')) return json({ loaded_context_length: 262144 });
      if (!url.endsWith('/chat/completions') || !body) return undefined;
      if (body.stream) return sse();
      const rf = body.response_format as { type: string } | undefined;
      if (rf?.type === 'json_object')
        return json({ error: "'response_format.type' must be 'json_schema' or 'text'" }, 500);
      if (rf) return reply('', { reasoning_content: '{"ok": true}' });
      return reply('', { tool_calls: [{ id: '1' }] });
    });
    const c = await probeCapabilities(host, { fetchImpl: f, now });
    expect(c).toMatchObject({ contextWindow: 262144, jsonMode: 'yes', toolUse: 'yes' });
    expect(c.notes.join(' ')).toMatch(/json_schema/);
  });

  it('reads Ollama context length from /api/show', async () => {
    const f = server((url, body) => {
      if (url.endsWith('/api/show'))
        return json({ model_info: { 'llama.context_length': 131072 } });
      if (!url.endsWith('/chat/completions') || !body) return undefined;
      return body.stream ? sse() : reply('{"ok":true}');
    });
    expect((await probeCapabilities(host, { fetchImpl: f })).contextWindow).toBe(131072);
  });

  it('says streaming is unsupported when the server answers one body, and blocks on it', async () => {
    const f = server((url, body) =>
      url.endsWith('/chat/completions') && body ? reply('ok') : undefined,
    );
    const c = await probeCapabilities(host, { fetchImpl: f });
    expect(c.streaming).toBe('no');
    expect(capabilityProblems(c)[0]).toMatch(/does not stream/);
  });

  it('keeps unknown unknown when the server is unreachable — never a wrong "no"', async () => {
    const f = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const c = await probeCapabilities(host, { fetchImpl: f });
    expect(c).toMatchObject({ streaming: 'unknown', jsonMode: 'unknown', toolUse: 'unknown' });
    expect(capabilityProblems(c)).toEqual([]);
  });
});

describe('capabilityProblems', () => {
  const base: Capabilities = {
    contextWindow: null,
    streaming: 'yes',
    jsonMode: 'no',
    toolUse: 'no',
    notes: [],
    probedAt: '',
  };
  it('does not block on missing JSON mode or tool use', () => {
    expect(capabilityProblems(base)).toEqual([]);
  });
  it('blocks a context window too small for a pass, with the number in the sentence', () => {
    expect(capabilityProblems({ ...base, contextWindow: 4096 })[0]).toMatch(/4096 tokens/);
  });
});
