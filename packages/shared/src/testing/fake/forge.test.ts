import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_PRS, FAKE_PR_FILES, FAKE_TOKEN, startFakeForge, type FakeForge } from './forge.js';

// W19-14: the fake forge serves a pull request's files WITH PATCHES, so the AI
// pass's diff mode has a forge to read from.

describe('the fake forge: pull request files', () => {
  let forge: FakeForge;
  beforeAll(async () => {
    forge = await startFakeForge(0);
  });
  afterAll(async () => {
    await forge.close();
  });
  const get = (path: string, token: string | null = FAKE_TOKEN) =>
    fetch(
      `${forge.baseUrl}${path}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );

  it('returns each file with its unified patch, in the shape GitHub sends', async () => {
    const res = await get('/repos/fixture-org/alpha-service/pulls/12/files');
    expect(res.status).toBe(200);
    const files = (await res.json()) as {
      filename: string;
      status: string;
      patch: string;
      additions: number;
    }[];
    expect(files.map((f) => f.filename)).toEqual([
      'src/payments/refund.ts',
      'src/payments/format.ts',
    ]);
    const refund = files[0]!;
    expect(refund.status).toBe('added');
    expect(refund.patch).toMatch(/^@@ -0,0 \+1,16 @@/);
    // A real injection for a real model to find, beside a parameterised query it should not flag.
    expect(refund.patch).toContain('"SELECT * FROM refunds WHERE id = " + id');
    expect(refund.patch).toContain('LIMIT $1');
    // Hunk header counts agree with the lines that follow, so a parser trusting them is not misled.
    const added = refund.patch.split('\n').filter((l) => l.startsWith('+')).length;
    expect(added).toBe(16);
    expect(refund.additions).toBe(16);
  });

  it('serves a second pull request that is NOT in the ingestion fixtures, and nothing for an unknown one', async () => {
    const res = await get('/repos/fixture-org/alpha-service/pulls/13/files');
    expect(((await res.json()) as { filename: string }[]).map((f) => f.filename)).toEqual([
      'src/auth/session.ts',
    ]);
    expect(Object.keys(FAKE_PR_FILES).map(Number)).toContain(13);
    // The ingestion fixtures (and the counts e2e asserts on) are untouched.
    expect(FAKE_PRS.map((p) => p.number)).toEqual([11, 12]);
    const none = await get('/repos/fixture-org/alpha-service/pulls/99/files');
    expect(await none.json()).toEqual([]);
  });

  it('still checks the credential', async () => {
    expect((await get('/repos/fixture-org/alpha-service/pulls/12/files', null)).status).toBe(401);
    expect((await get('/repos/fixture-org/alpha-service/pulls/12/files', 'wrong')).status).toBe(
      401,
    );
  });
});
