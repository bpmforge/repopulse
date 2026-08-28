import { describe, expect, it, vi } from 'vitest';
import { resolveProvider } from './registry.js';
import { T2Client, T2_DEFAULTS } from '../t2/client.js';

// Amazon Bedrock, through the ordinary OpenAI-compatible transport (W16-09).
//
// The board said Bedrock "signs each request with the AWS credential chain
// (SigV4) rather than sending a key" and that it therefore needed its own auth
// mechanism. Verified against the AWS documentation on 2026-08-28, that is no
// longer true: bedrock-runtime exposes an OpenAI-compatible Chat Completions
// API which accepts an Amazon Bedrock API key as `Authorization: Bearer`.
//
//   https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions
//
// WHAT THESE TESTS CAN AND CANNOT PROVE. There is no AWS account here, so they
// do not prove AWS accepts the request. They prove the request WE build matches
// the contract AWS documents — the URL and the header — which is the half that
// is ours to get right. The `supported` flag is not taken on trust either: the
// same transport is exercised against a real model elsewhere (the Tier-2 live
// test and the demo's own runs), so this is a configuration entry on a proven
// path rather than an unexercised one.

const BEDROCK_BASE = 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1';

function bedrockHost() {
  return resolveProvider({
    id: 1,
    name: 'Bedrock us-east-1',
    kind: 'bedrock',
    baseUrl: BEDROCK_BASE,
    model: 'openai.gpt-oss-120b',
    apiKey: 'bedrock-api-key-fixture',
    // Bedrock is a public host, so it needs the SC-24 opt-in a person makes
    // deliberately on the row. Without it the host policy refuses, which is
    // the behaviour that control exists for.
    allowPublicHost: true,
  });
}

describe('Amazon Bedrock is an OpenAI-compatible endpoint with a key (W16-09)', () => {
  it('resolves without demanding a signer or a cloud credential chain', () => {
    const host = bedrockHost();
    expect(host.baseUrl).toBe(BEDROCK_BASE);
    expect(host.modelSlot).toBe('openai.gpt-oss-120b');
    expect(host.auth?.apiKey).toBe('bedrock-api-key-fixture');
    // Bearer, not x-api-key: only Anthropic overrides the header.
    expect(host.auth?.authHeader).toBeUndefined();
  });

  it('refuses a public Bedrock endpoint without the SC-24 opt-in', () => {
    expect(() =>
      resolveProvider({
        id: 1,
        name: 'Bedrock',
        kind: 'bedrock',
        baseUrl: BEDROCK_BASE,
        model: 'openai.gpt-oss-120b',
        apiKey: 'k',
        allowPublicHost: false,
      }),
    ).toThrow();
  });

  it('refuses a hosted Bedrock endpoint with no key at all', () => {
    expect(() =>
      resolveProvider({
        id: 1,
        name: 'Bedrock',
        kind: 'bedrock',
        baseUrl: BEDROCK_BASE,
        model: 'openai.gpt-oss-120b',
        allowPublicHost: true,
      }),
    ).toThrow(/API key/i);
  });

  it('builds the URL and header AWS documents, verbatim', async () => {
    // The one assertion that matters, because everything else is our own
    // vocabulary. `normalizeHost` strips the trailing /v1 and the client adds
    // /v1/chat/completions back, so a base URL ending in /openai/v1 lands on
    // the documented path rather than doubling or dropping a segment.
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const host = bedrockHost();
    const client = new T2Client(
      { ...T2_DEFAULTS, hosts: [host], concurrencyCap: 1 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: () => Promise.resolve() },
    );
    await client.complete(
      'hello',
      {
        tier: 'T2',
        maxTokens: 16,
        expectJson: true,
        meta: {
          repoId: '1',
          prNumber: 0,
          dimension: 'security',
          checklistVersion: 'w16-09-fixture',
          initiator: 'test',
        },
      },
      host,
    );

    const call = seen.at(-1)!;
    expect(call.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions',
    );
    expect(call.headers['authorization']).toBe('Bearer bedrock-api-key-fixture');
    expect(call.headers['content-type']).toBe('application/json');
  });
});
