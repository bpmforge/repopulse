import { describe, expect, it } from 'vitest';
import { createAnalysisGateway } from '@repopulse/analysis';
import { hostsFromEnv } from './gateway.js';

// A REAL Tier-2 call (carry-forward from W9-03/W9-04/W9-07).
//
// Every gateway test in this repository has run against a stub. Nothing had
// ever called a model through it, because nothing built one — so the warm-up,
// the crash retry and the token cap were all written and never exercised
// against a real LM Studio.
//
// Skips when no host answers, and says so rather than passing quietly: this is
// a proof that the path works, and a proof nobody ran is not a proof.

const HOST = process.env.LMSTUDIO_LIVE_URL ?? 'http://localhost:1234/v1';

/** The first model the host actually has loaded — never a guessed name. */
const model: string | null = await fetch(`${HOST}/models`, { signal: AbortSignal.timeout(3000) })
  .then(async (r) => (r.ok ? (((await r.json()) as { data?: { id: string }[] }).data?.[0]?.id ?? null) : null))
  .catch(() => null);

const describeIfLmStudio = model ? describe : describe.skip;

describeIfLmStudio('the analysis gateway, against a real model', () => {
  const gateway = createAnalysisGateway({
    hosts: hostsFromEnv({
      LMSTUDIO_BASE_URLS: HOST,
      LMSTUDIO_MODEL: model ?? '',
    } as NodeJS.ProcessEnv),
  });

  it('reports the host healthy', async () => {
    expect(await gateway.health('T2')).toMatchObject({ ok: true });
  }, 120_000);

  it('completes a Tier-2 prompt and returns parseable JSON', async () => {
    // JSON, not prose: `expectJson: true` is required by CompleteOpts because
    // every real caller parses the answer. A live test that asked for a word
    // would exercise a path no scanner uses.
    const result = await gateway.complete(
      'Reply with only this JSON and nothing else: {"status":"ready"}',
      {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: '0',
          prNumber: 0,
          dimension: 'code_health',
          checklistVersion: 'live.v1',
          initiator: 'test:gateway-live',
        },
      },
    );
    expect(result.text.toLowerCase()).toContain('ready');
    expect(result.model).toBeTruthy();
  }, 300_000);

  it('REFUSES Tier-3 rather than quietly downgrading to Tier-2', async () => {
    // The control that matters most here: a scheduled pass must never reach a
    // third-party API because a local host was busy.
    await expect(
      gateway.complete('anything', {
        tier: 'T3',
        maxTokens: 1000,
        expectJson: true,
        meta: {
          repoId: '0',
          prNumber: 0,
          dimension: 'code_health',
          checklistVersion: 'live.v1',
          initiator: 'test:gateway-live',
        },
      }),
    ).rejects.toThrow();
  }, 60_000);
});
