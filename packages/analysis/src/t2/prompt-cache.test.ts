import { describe, expect, it, vi } from 'vitest';
import { T2Client, T2_DEFAULTS, chatMessages, cacheReadTokensOf } from './client.js';
import type { CompleteOpts } from '../gateway/types.js';
import { resolveProvider } from '../providers/registry.js';

// W23-06. Message shape on the OpenAI-compatible transport (LM Studio, Bedrock
// and Vertex's OpenAI-compatible surfaces all go through it), and cache-read
// usage parsing with and without `prompt_tokens_details`.

const HOST = { baseUrl: 'http://lan:1234', modelSlot: 'qwen' };
const PARTS = { static: 'CHECKLIST + SCHEMA', dynamic: 'PR + DIFF' };
const PROMPT = `${PARTS.static}\n\n${PARTS.dynamic}`;
const opts: CompleteOpts = {
  tier: 'T2',
  maxTokens: 100,
  expectJson: true,
  meta: {
    repoId: '1',
    prNumber: 2,
    dimension: 'code_health',
    checklistVersion: 'v1',
    initiator: 'test',
  },
  promptParts: PARTS,
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
const reply = (usage: Record<string, unknown>) =>
  json({ choices: [{ message: { content: '{"findings":[]}' } }], model: 'qwen', usage });

function run(host: typeof HOST, o: CompleteOpts, prompt: string, usage: Record<string, unknown>) {
  const bodies: {
    messages: { role: string; content: string }[];
    max_tokens: number;
    temperature: number;
  }[] = [];
  const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as (typeof bodies)[number];
    if (!b.messages.some((m) => m.content === 'ping')) bodies.push(b);
    return reply(usage);
  }) as unknown as typeof fetch;
  const client = new T2Client(
    { ...T2_DEFAULTS, hosts: [host], concurrencyCap: 1 },
    { fetchImpl, sleep: () => Promise.resolve() },
  );
  return { bodies, result: client.complete(prompt, o, host) };
}

describe('chat message shape', () => {
  it('static as system, dynamic as user, with max_tokens and temperature unchanged', async () => {
    const { bodies, result } = run(HOST, opts, PROMPT, { prompt_tokens: 10, completion_tokens: 4 });
    await result;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.messages).toEqual([
      { role: 'system', content: PARTS.static },
      { role: 'user', content: PARTS.dynamic },
    ]);
    expect(bodies[0]!.max_tokens).toBe(45000);
    expect(bodies[0]!.temperature).toBe(0.1);
  });

  it('is the single user message when no parts are given', async () => {
    const { promptParts: _unused, ...plain } = opts;
    void _unused;
    const { bodies, result } = run(HOST, plain, 'whole prompt', {});
    await result;
    expect(bodies[0]!.messages).toEqual([{ role: 'user', content: 'whole prompt' }]);
  });

  it('is the single user message when the prompt was changed after the split (retry note)', () => {
    expect(chatMessages(`${PROMPT}\n\nretry`, PARTS)).toEqual([
      { role: 'user', content: `${PROMPT}\n\nretry` },
    ]);
  });

  it('Bedrock (OpenAI-compatible) gets the same system/user shape', async () => {
    const host = resolveProvider({
      id: 1,
      name: 'Bedrock',
      kind: 'bedrock',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      model: 'openai.gpt-oss-120b',
      apiKey: 'k',
      allowPublicHost: true,
    });
    const { bodies, result } = run(host as never, opts, PROMPT, {});
    await result;
    expect(bodies[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('cache-read usage', () => {
  it('reads usage.prompt_tokens_details.cached_tokens', async () => {
    const { result } = run(HOST, opts, PROMPT, {
      prompt_tokens: 1000,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(await result).toMatchObject({ tokensIn: 1000, cacheReadTokens: 800 });
  });

  it('is 0 when the server reports no details (LM Studio) or no usage at all', async () => {
    expect(
      await run(HOST, opts, PROMPT, { prompt_tokens: 10, completion_tokens: 4 }).result,
    ).toMatchObject({
      cacheReadTokens: 0,
    });
    expect(await run(HOST, opts, PROMPT, {}).result).toMatchObject({
      tokensIn: 0,
      cacheReadTokens: 0,
    });
    expect(cacheReadTokensOf({ prompt_tokens_details: {} })).toBe(0);
    expect(cacheReadTokensOf({ prompt_tokens_details: { cached_tokens: -5 } })).toBe(0);
  });
});
