import { describe, expect, it, vi } from 'vitest';
import {
  createAppHeaderProvider,
  createAuthHeaderProvider,
  type InstallationToken,
} from '../src/github/auth.js';

describe('PAT auth', () => {
  it('emits a static Bearer header, no lifecycle', async () => {
    const provider = createAuthHeaderProvider({ kind: 'pat', token: 'ghp_example' });
    expect(await provider.headers()).toEqual({ authorization: 'Bearer ghp_example' });
    provider.invalidate(); // no-op
    expect(await provider.headers()).toEqual({ authorization: 'Bearer ghp_example' });
  });
});

describe('App installation-token lifecycle (FR-FORGE-5)', () => {
  const HOUR = 60 * 60 * 1000;

  function minterReturning(tokens: InstallationToken[]) {
    let i = 0;
    return vi.fn(async () => tokens[Math.min(i++, tokens.length - 1)] as InstallationToken);
  }

  it('mints once, then reuses the cached token until the 50-minute refresh point', async () => {
    let clock = 1_000_000;
    const mint = minterReturning([{ token: 'inst-1', expiresAtMs: 1_000_000 + HOUR }]);
    const provider = createAppHeaderProvider({
      mintInstallationToken: mint,
      now: () => clock,
    });

    expect((await provider.headers()).authorization).toBe('Bearer inst-1');
    clock += 40 * 60 * 1000; // +40min — still inside the window
    await provider.headers();
    expect(mint).toHaveBeenCalledTimes(1); // reused, not re-minted
  });

  it('re-mints proactively once within 10 minutes of expiry (~50min)', async () => {
    let clock = 1_000_000;
    const mint = minterReturning([
      { token: 'inst-1', expiresAtMs: 1_000_000 + HOUR },
      { token: 'inst-2', expiresAtMs: 1_000_000 + 51 * 60 * 1000 + HOUR },
    ]);
    const provider = createAppHeaderProvider({ mintInstallationToken: mint, now: () => clock });

    expect((await provider.headers()).authorization).toBe('Bearer inst-1');
    clock += 51 * 60 * 1000; // past expiry - 10min skew
    expect((await provider.headers()).authorization).toBe('Bearer inst-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces a re-mint on the next call (401 recovery)', async () => {
    const mint = minterReturning([
      { token: 'inst-1', expiresAtMs: Date.now() + HOUR },
      { token: 'inst-2', expiresAtMs: Date.now() + HOUR },
    ]);
    const provider = createAppHeaderProvider({ mintInstallationToken: mint });

    expect((await provider.headers()).authorization).toBe('Bearer inst-1');
    provider.invalidate();
    expect((await provider.headers()).authorization).toBe('Bearer inst-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent mints into a single token exchange', async () => {
    let resolve!: (t: InstallationToken) => void;
    const mint = vi.fn(
      () =>
        new Promise<InstallationToken>((r) => {
          resolve = r;
        }),
    );
    const provider = createAppHeaderProvider({ mintInstallationToken: mint });

    const a = provider.headers();
    const b = provider.headers();
    resolve({ token: 'inst-1', expiresAtMs: Date.now() + HOUR });
    await Promise.all([a, b]);
    expect(mint).toHaveBeenCalledTimes(1);
  });
});
