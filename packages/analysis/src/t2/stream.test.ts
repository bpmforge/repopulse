import { describe, expect, it } from 'vitest';
import { readChatStream, describeTransportError } from './client.js';

// Streaming the Tier-2 reply (W16-39).
//
// Non-streaming, an OpenAI-compatible endpoint sends no response headers until
// the whole generation is finished — and undici's default headersTimeout is
// 300 seconds. A 27B reasoning model on this tier's 45000-token budget takes
// longer, so the connection died before the first byte and every checklist
// recorded a bare "fetch failed". Measured against a real host:
// UND_ERR_HEADERS_TIMEOUT at 301.0s, reproducibly; streaming, headers at 0.04s.
//
// These tests are about the ASSEMBLY, which is the part that can be wrong
// quietly: a stream reassembled badly produces a truncated answer, and a
// truncated answer is a finding nobody made.

function sse(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

describe('assembling a streamed reply', () => {
  it('joins the content deltas in order', async () => {
    const body = await readChatStream(
      sse(
        frame({ model: 'm', choices: [{ delta: { content: '{"find' } }] }),
        frame({ choices: [{ delta: { content: 'ings":' } }] }),
        frame({ choices: [{ delta: { content: '[]}' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ),
    );
    expect(body.choices?.[0]?.message?.content).toBe('{"findings":[]}');
    expect(body.choices?.[0]?.finish_reason).toBe('stop');
    expect(body.model).toBe('m');
  });

  it('survives a frame split across chunk boundaries', async () => {
    // The failure this prevents: a JSON frame arriving in two TCP reads, parsed
    // as two broken halves, and the answer silently losing a token.
    const whole = frame({ choices: [{ delta: { content: 'hello world' } }] });
    const cut = Math.floor(whole.length / 2);
    const body = await readChatStream(sse(whole.slice(0, cut), whole.slice(cut)));
    expect(body.choices?.[0]?.message?.content).toBe('hello world');
  });

  it('keeps reasoning SEPARATE from the answer', async () => {
    // Folding them together would feed a model's thinking to a JSON parser and
    // destroy the distinction W16-38 uses to tell "never answered" from "found
    // nothing".
    const body = await readChatStream(
      sse(
        frame({ choices: [{ delta: { reasoning_content: 'let me think…' } }] }),
        frame({ choices: [{ delta: { content: '{"findings":[]}' } }] }),
      ),
    );
    expect(body.choices?.[0]?.message?.content).toBe('{"findings":[]}');
    expect(body.choices?.[0]?.message?.reasoning_content).toBe('let me think…');
  });

  it('carries usage through, or FR-SEC-7 spend rows all read zero', async () => {
    const body = await readChatStream(
      sse(
        frame({ choices: [{ delta: { content: 'x' } }] }),
        frame({ choices: [], usage: { prompt_tokens: 61, completion_tokens: 55 } }),
      ),
    );
    expect(body.usage).toEqual({ prompt_tokens: 61, completion_tokens: 55 });
  });

  it('skips a malformed frame instead of failing the whole call', async () => {
    // These streams carry keep-alives and end with [DONE]; losing a scan
    // because one frame did not parse would turn a cosmetic difference between
    // servers into a lost result.
    const body = await readChatStream(
      sse(
        ': keep-alive\n\n',
        'data: {not json\n\n',
        frame({ choices: [{ delta: { content: 'ok' } }] }),
        'data: [DONE]\n\n',
      ),
    );
    expect(body.choices?.[0]?.message?.content).toBe('ok');
  });

  it('reports an empty stream as empty content, not as a crash', async () => {
    const body = await readChatStream(sse('data: [DONE]\n\n'));
    expect(body.choices?.[0]?.message?.content).toBe('');
  });
});

describe('a transport failure says WHY (W16-39)', () => {
  it('unwraps the cause undici hides behind "fetch failed"', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    const outer = new Error('fetch failed', { cause });
    const described = describeTransportError(outer);
    expect(described).toContain('fetch failed');
    expect(described).toContain('Headers Timeout Error');
    // The code is the part someone can search for.
    expect(described).toContain('UND_ERR_HEADERS_TIMEOUT');
  });

  it('is the plain message when there is no cause to add', () => {
    expect(describeTransportError(new Error('boom'))).toBe('boom');
    expect(describeTransportError('not an error')).toBe('not an error');
  });
});

describe('a completion is bounded, even though streaming removed the old bound (W16-39)', () => {
  it('aborts with a reason a person can act on', async () => {
    // Before streaming, undici's 300s headersTimeout bounded every call —
    // badly, killing legitimate slow generations. Streaming fixed that and, on
    // its own, would have left NO bound at all: a stalled stream would hang
    // for ever and the scan_run would sit at 'running' until someone noticed.
    const { T2Client, T2_DEFAULTS } = await import('./client.js');
    const host = { baseUrl: 'http://10.0.0.5:1234/v1', modelSlot: 'm' };

    // A transport that never resolves — a stalled stream, not a slow one.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
        );
      })) as unknown as typeof fetch;

    const client = new T2Client(
      { ...T2_DEFAULTS, hosts: [host], concurrencyCap: 1, requestTimeoutMs: 30, warmup: { pingPrompt: 'p', timeoutMs: 10, retries: 0 } },
      { fetchImpl, sleep: () => Promise.resolve() },
    );

    await expect(
      client.complete(
        'x',
        {
          tier: 'T2',
          maxTokens: 16,
          expectJson: true,
          meta: { repoId: '1', prNumber: 0, dimension: 'security', checklistVersion: 'v', initiator: 't' },
        },
        host,
      ),
    ).rejects.toThrow(/did not finish within/);
  });
});
