import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PRESETS,
  PROVIDER_REGISTRY,
  ProviderConfigError,
  SUPPORTED_KINDS,
  resolveProvider,
  type ProviderConfig,
} from './registry.js';
import { HostPolicyError, requestHeadersFor, T2_REQUEST_HEADERS } from '../config/hosts.js';

// W16-06 (D-LLM-1, F5-F7). The review found that "bring your own LLM" was
// impossible: Tier 2 was LAN-only by host policy AND credential-free by a frozen
// header set, so no hosted provider could ever be reached, and there was no
// configuration surface anywhere. These tests pin the new behaviour and, just
// as importantly, pin what did NOT change.

function config(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 1,
    name: 'test',
    kind: 'openai_compatible',
    baseUrl: 'http://192.168.1.50:1234/v1',
    model: 'qwen3-coder',
    allowPublicHost: false,
    ...over,
  };
}

describe('the strict default is unchanged', () => {
  it('still refuses a public host when nobody opted in', () => {
    // The control SC-24 exists for: diffs are the most sensitive thing the
    // warehouse holds, so the default must stay private-range only.
    expect(() =>
      resolveProvider(config({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' })),
    ).toThrow(HostPolicyError);
  });

  it('still refuses the cloud metadata endpoint even WITH the opt-in', () => {
    // 169.254.169.254 is link-local, so a private-range check alone waves it
    // through. It is the single most valuable SSRF target there is, and no
    // per-row opt-in may reach it.
    expect(() =>
      resolveProvider(
        config({ baseUrl: 'http://169.254.169.254/v1', allowPublicHost: true, apiKey: 'k' }),
      ),
    ).toThrow(HostPolicyError);
  });

  it('sends no credential for a LAN host', () => {
    const host = resolveProvider(config());
    expect(host.auth).toBeUndefined();
    expect(Object.keys(requestHeadersFor(host.auth))).toEqual(['content-type']);
  });

  it('keeps the base header set frozen and credential-free', () => {
    expect(Object.isFrozen(T2_REQUEST_HEADERS)).toBe(true);
    expect(Object.keys(T2_REQUEST_HEADERS)).toEqual(['content-type']);
  });
});

describe('a human-authored provider row is the opt-out', () => {
  it('reaches a hosted endpoint when the row says so, with a bearer token', () => {
    const host = resolveProvider(
      config({ baseUrl: 'https://api.openai.com/v1', allowPublicHost: true, apiKey: 'sk-secret' }),
    );
    expect(host.baseUrl).toBe('https://api.openai.com/v1');
    expect(requestHeadersFor(host.auth).authorization).toBe('Bearer sk-secret');
  });

  it('uses x-api-key for Anthropic, which does not take a bearer token', () => {
    const host = resolveProvider(
      config({ kind: 'anthropic', baseUrl: null, allowPublicHost: true, apiKey: 'sk-ant' }),
    );
    // The endpoint is fixed by the vendor, so the row need not carry one.
    expect(host.baseUrl).toBe('https://api.anthropic.com');
    const headers = requestHeadersFor(host.auth);
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers.authorization).toBeUndefined();
  });

  it('refuses a hosted endpoint with no key, rather than calling it and getting a 401', () => {
    expect(() =>
      resolveProvider(config({ baseUrl: 'https://api.groq.com/openai/v1', allowPublicHost: true })),
    ).toThrow(ProviderConfigError);
  });

  it('carries extra headers verbatim, lower-cased', () => {
    const host = resolveProvider(
      config({ headers: { 'HTTP-Referer': 'https://repopulse.local' } }),
    );
    expect(requestHeadersFor(host.auth)['http-referer']).toBe('https://repopulse.local');
  });

  it('refuses a credential smuggled into the headers bag', () => {
    // That column is not encrypted. Dropping it silently would leave someone
    // believing their key was sent and stored safely; neither would be true.
    const host = resolveProvider(config({ headers: { Authorization: 'Bearer sneaky' } }));
    expect(() => requestHeadersFor(host.auth)).toThrow(HostPolicyError);
  });

  it('never lets an extra header shadow the credential', () => {
    const headers = requestHeadersFor({ apiKey: 'real', extra: { 'content-type': 'text/plain' } });
    expect(headers.authorization).toBe('Bearer real');
  });
});

describe('configuration errors surface at configuration time', () => {
  it('names the auth mechanism an unsupported kind needs', () => {
    // Bedrock left this list in W16-09, Vertex in W19-01 — both are supported now.
    for (const kind of ['copilot', 'openai_subscription'] as const) {
      expect(() => resolveProvider(config({ kind, baseUrl: null }))).toThrow(ProviderConfigError);
      expect(PROVIDER_REGISTRY[kind].unsupportedReason).toBeTruthy();
    }
  });

  it('refuses a blank model id', () => {
    // The failure it prevents: a blank model is sent as the identifier and the
    // endpoint 400s on every call, reading as "the model is not loaded".
    expect(() => resolveProvider(config({ model: '  ' }))).toThrow(ProviderConfigError);
  });

  it('supports the api-key kinds, which now includes Bedrock (W16-09)', () => {
    // Bedrock joined this list without a line of transport code: AWS exposes
    // an OpenAI-compatible Chat Completions API on bedrock-runtime that takes
    // an Amazon Bedrock API key as a bearer token, so the entry that called it
    // a SigV4-only cloud credential was simply out of date.
    // Gemini and Vertex joined in W19-01.
    expect([...SUPPORTED_KINDS].sort()).toEqual([
      'anthropic',
      'bedrock',
      'gemini',
      'openai_compatible',
      'vertex',
    ]);
  });

  it('Gemini rides its OpenAI-compatible endpoint with a fixed chat URL (W19-01)', () => {
    const host = resolveProvider(
      config({
        kind: 'gemini',
        baseUrl: null,
        model: 'gemini-2.5-flash',
        apiKey: 'k',
        allowPublicHost: true,
      }),
    );
    expect(host.chatUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('Gemini is still subject to the SC-24 host policy without the per-row opt-in', () => {
    expect(() =>
      resolveProvider(config({ kind: 'gemini', baseUrl: null, model: 'm', apiKey: 'k' })),
    ).toThrow();
  });

  it('Vertex takes the project/region URL the person gives and appends the chat path', () => {
    const base =
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi/';
    const host = resolveProvider(
      config({
        kind: 'vertex',
        baseUrl: base,
        model: 'google/gemini-2.5-flash',
        apiKey: 'tok',
        allowPublicHost: true,
      }),
    );
    expect(host.chatUrl).toBe(`${base.replace(/\/$/, '')}/chat/completions`);
    expect(() => resolveProvider(config({ kind: 'vertex', baseUrl: null, model: 'm' }))).toThrow(
      /no base URL/,
    );
  });

  it('ships a preset for every local server the product names, all on the one adapter', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      'lmstudio',
      'ollama',
      'mlx',
      'unsloth',
      'vllm',
      'litellm',
    ]);
    for (const p of PROVIDER_PRESETS) {
      expect(p.kind).toBe('openai_compatible');
      const host = resolveProvider(config({ baseUrl: p.baseUrl, model: 'm' }));
      expect(host.chatUrl).toBeUndefined();
    }
  });

  it('one adapter covers local and hosted alike', () => {
    // The finding this closes: the product spoke of "LM Studio" and "Claude
    // API" as though they were the only two options, when the wire format it
    // already used is the industry default.
    for (const baseUrl of [
      'http://localhost:11434/v1',
      'http://192.168.1.50:1234/v1',
      'http://10.0.0.9:8000/v1',
    ]) {
      expect(resolveProvider(config({ baseUrl })).baseUrl).toBe(baseUrl);
    }
    for (const baseUrl of [
      'https://openrouter.ai/api/v1',
      'https://api.groq.com/openai/v1',
      'https://api.together.xyz/v1',
    ]) {
      const host = resolveProvider(config({ baseUrl, allowPublicHost: true, apiKey: 'k' }));
      expect(host.baseUrl).toBe(baseUrl);
    }
  });
});
