import { describe, expect, it } from 'vitest';
import { hostsFromEnv, missingGatewayConfig, reportGatewayHealth } from './gateway.js';

const MODEL = { LMSTUDIO_MODEL: 'qwen3.8-27b' };

// Gateway construction (carry-forward from W9-03/W9-04/W9-07).
//
// The defect these cover: NOTHING in the product built an analysis gateway.
// createAnalysisGateway was exercised only by its own unit test, so Law 8 held
// vacuously — every LLM call went through the gateway, and there were none.

describe('reading Tier-2 hosts from config', () => {
  it('parses the documented comma-separated shape', () => {
    const hosts = hostsFromEnv({
      ...MODEL,
      LMSTUDIO_BASE_URLS: 'http://a:1234/v1,http://b:1234/v1',
    } as NodeJS.ProcessEnv);
    expect(hosts.map((h) => h.baseUrl)).toEqual(['http://a:1234/v1', 'http://b:1234/v1']);
  });

  it('tolerates spaces and a trailing comma, which a hand-edited .env has', () => {
    const hosts = hostsFromEnv({
      ...MODEL,
      LMSTUDIO_BASE_URLS: ' http://a:1234/v1 , http://b:1234/v1 ,',
    } as NodeJS.ProcessEnv);
    expect(hosts).toHaveLength(2);
  });

  it('returns NO hosts when unset — a supported deployment, not a fault', () => {
    expect(hostsFromEnv({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(hostsFromEnv({ ...MODEL, LMSTUDIO_BASE_URLS: '' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('refuses to guess a model name', () => {
    // The first version defaulted to 'default'; LM Studio answered
    // `Invalid model identifier "default"` on every call. A guessed model name
    // is a guess about someone else's machine.
    expect(
      hostsFromEnv({ LMSTUDIO_BASE_URLS: 'http://a:1234/v1' } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it('names the HALF-configured case, which looks configured and 400s', () => {
    expect(missingGatewayConfig({ LMSTUDIO_BASE_URLS: 'http://a:1234/v1' } as NodeJS.ProcessEnv))
      .toContain('LMSTUDIO_MODEL is not');
    expect(missingGatewayConfig({ ...MODEL, LMSTUDIO_BASE_URLS: 'http://a:1234/v1' } as NodeJS.ProcessEnv))
      .toBeNull();
  });
});

describe('what the operator is told at boot', () => {
  it('says NOT CONFIGURED, and what that means for the passes', async () => {
    const message = await reportGatewayHealth(null);
    expect(message).toContain('NOT CONFIGURED');
    expect(message).toContain('skip and say so');
  });

  it('distinguishes configured-but-unreachable from absent', async () => {
    // The failure an operator actually hits: LMSTUDIO_BASE_URLS points at a
    // host that is off, or on a network the worker cannot reach. Today they
    // would learn that from findings which never appear.
    const built = {
      hosts: [{ baseUrl: 'http://127.0.0.1:9/v1', modelSlot: 'default' }],
      gateway: { health: async () => ({ ok: false }) } as never,
    };
    const message = await reportGatewayHealth(built);
    expect(message).toContain('UNREACHABLE');
    expect(message).toContain('not silently skip');
  });
});
