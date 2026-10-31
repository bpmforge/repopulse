import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { T2Client, T2_DEFAULTS, normalizeHost } from './client.js';
import { joinPromptParts, type CompleteOpts } from '../gateway/types.js';
import { buildPromptParts } from '../chunker/prompt.js';

// LIVE Tier-2 test against a real LM Studio host (W6-01).
//
// This is the only test in the wrapper suite that proves the thing that matters:
// that the client speaks a protocol a real model answers. Everything else is a
// fetch double, which can only ever confirm that our own shapes agree with
// themselves — exactly the trap the fake-forge contract suites fell into, where
// GiteaProvider passed for months without ever touching a Gitea.
//
// OPT-IN (W17-40): runs only with LMSTUDIO_LIVE=1. It used to run whenever a
// host could be found — and localhost was always appended, so it never
// skipped: every `pnpm test` warmed a model with "ping" (bursts of three) on
// the developer's own LM Studio and evicted whatever other tools had loaded.
// A configured LMSTUDIO_BASE_URLS is NOT consent: .env carries it for the
// product. Run it deliberately: `LMSTUDIO_LIVE=1 pnpm test`.
const LIVE = process.env.LMSTUDIO_LIVE === '1';

// With consent, localhost is appended as a candidate: a developer running LM
// Studio on the same machine is the common case, and the configured LAN host
// is frequently a closed laptop. The test uses whichever candidate answers.
const hosts = LIVE
  ? [
      ...(process.env.LMSTUDIO_BASE_URLS ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      'http://localhost:1234',
    ]
  : [];

const describeIfLmStudio = LIVE ? describe : describe.skip;

describeIfLmStudio('tier-2 against a live LM Studio host', () => {
  /** The first candidate host that actually answers, with its loaded model. */
  async function liveHost(): Promise<{ baseUrl: string; model: string } | null> {
    for (const candidate of hosts) {
      try {
        const res = await fetch(`${normalizeHost(candidate)}/v1/models`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { data?: { id?: string }[] };
        const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
        // Prefer the model production is configured to use. `/v1/models` lists
        // EVERY downloaded model, first-listed being whichever LM Studio happens
        // to have loaded — on 2026-09-14 that was an experimental ablated 9B
        // that answered with reasoning_content and an empty content, and this
        // test failed on a model the product would never have been pointed at.
        // The fallback to the first id keeps the test running on a machine
        // with no LMSTUDIO_MODEL set.
        const preferred = process.env.LMSTUDIO_MODEL?.trim();
        const model = preferred && ids.includes(preferred) ? preferred : ids[0];
        if (model) return { baseUrl: candidate, model };
      } catch {
        /* candidate is down — try the next */
      }
    }
    return null;
  }

  it('reports health from a real /v1/models response', async () => {
    const live = await liveHost();
    if (live === null) {
      // The host is configured but not up. Reported, not failed: an unreachable
      // LAN host is a normal state (NFR-7), and failing here would make the
      // suite depend on a laptop being open.
      console.warn('[w6-01] no LM Studio candidate reachable — live assertions skipped');
      // Nothing asserted on purpose: an unreachable LAN host is a normal state
      // (NFR-7), and failing here would make the suite depend on a laptop
      // being open.
      return;
    }
    const host = { baseUrl: live.baseUrl, modelSlot: live.model };
    const client = new T2Client({ ...T2_DEFAULTS, hosts: [host], concurrencyCap: 1 });
    await expect(client.health(host)).resolves.toMatchObject({ ok: true });
  });

  it('completes a real prompt and returns usable JSON text', { timeout: 180_000 }, async () => {
    const live = await liveHost();
    if (live === null) return;
    const host = { baseUrl: live.baseUrl, modelSlot: live.model };
    const client = new T2Client({ ...T2_DEFAULTS, hosts: [host], concurrencyCap: 1 });
    const opts: CompleteOpts = {
      tier: 'T2',
      maxTokens: 100,
      expectJson: true,
      meta: {
        repoId: '1',
        prNumber: 1,
        dimension: 'code_health',
        checklistVersion: 'v1',
        initiator: 'w6-01-live',
      },
    };

    const result = await client.complete(
      'Reply with only this JSON and nothing else: {"ok":true}',
      opts,
      host,
    );

    // Deliberately weak assertions on CONTENT: the point is the transport, the
    // warm-up and the 45000 cap surviving a real round trip, not that a
    // particular model formats JSON a particular way. A strict content
    // assertion here would fail on a model swap and teach everyone to skip it.
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.model.length).toBeGreaterThan(0);
    expect(result.tokensIn).toBeGreaterThan(0);
    expect(result.costUsd).toBeNull();
    expect(result.durationMs).toBeGreaterThan(0);
    console.log(
      `[w6-01] live LM Studio: model=${result.model} in=${result.tokensIn} out=${result.tokensOut} ${result.durationMs}ms`,
    );
  });
  // W23-06 (INCREMENTAL_SCAN_PLAN X7). The static prefix (checklist + schema +
  // rules) is sent as the SYSTEM message, so a server with prefix caching
  // should answer the second chunk of a dimension faster than the first.
  //
  // COLD = a static block no server has seen (a nonce line at the top defeats
  // any cache); WARM = the same static block again with a DIFFERENT chunk.
  // Same dimension, same model, same output budget. The prompt asks for a
  // fixed one-line answer so the comparison is dominated by prompt processing
  // rather than by how long a reasoning model decides to think.
  //
  // Runs only under LMSTUDIO_LIVE=1 (the guard above) and returns early when no
  // host answers. A server with prefix caching OFF will fail the ratio, which
  // is the point: the ticket's claim is that this request shape makes it hit.
  it(
    'answers a second chunk of the same dimension in under 60% of the cold time (W23-06)',
    { timeout: 600_000 },
    async () => {
      const live = await liveHost();
      if (live === null) return;
      const host = { baseUrl: live.baseUrl, modelSlot: live.model };
      const client = new T2Client({ ...T2_DEFAULTS, hosts: [host], concurrencyCap: 1 });
      const chunk = (n: number) => ({
        text: `@@ -1,2 +1,3 @@\n const a = ${n};\n+const b = compute(${n});`,
        paths: [`src/f${n}.ts`],
        tokens: 30,
      });
      const base = buildPromptParts({
        dimension: 'security',
        chunk: chunk(1) as never,
        prTitle: 'w23-06 live',
        prBody: null,
      });
      const nonce = `[cache-probe ${Date.now()}-${Math.random().toString(36).slice(2)}]`;
      const staticPart = `${nonce}\n${base.static}\n\nFor THIS test reply with exactly {"findings":[]} and nothing else.`;
      const call = async (n: number) => {
        const dynamic = buildPromptParts({
          dimension: 'security',
          chunk: chunk(n) as never,
          prTitle: 'w23-06 live',
          prBody: null,
        }).dynamic;
        const parts = { static: staticPart, dynamic };
        const opts: CompleteOpts = {
          tier: 'T2',
          maxTokens: 100,
          expectJson: true,
          meta: {
            repoId: '1',
            prNumber: 1,
            dimension: 'security',
            checklistVersion: 'v1',
            initiator: 'w23-06-live',
          },
          promptParts: parts,
        };
        return client.complete(joinPromptParts(parts), opts, host);
      };

      // Load the model first (the client warms an unloaded host with a different
      // prompt) so the cold figure measures prefix processing, not model load.
      await client.warmUp(host);
      const cold = await call(1);
      const warm = await call(2);
      console.log(
        `[w23-06] cold=${cold.durationMs}ms warm=${warm.durationMs}ms ratio=${(warm.durationMs / cold.durationMs).toFixed(2)} cacheRead=${warm.cacheReadTokens ?? 0}`,
      );
      expect(warm.durationMs).toBeLessThan(cold.durationMs * 0.6);
    },
  );
});
