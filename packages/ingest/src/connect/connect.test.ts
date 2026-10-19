import { describe, expect, it } from 'vitest';
import { ForgeHttpError } from '@repopulse/forge';
import { MAX_LISTING_PAGES, classifySmokeError, collectAllPages } from './connect.js';

// W20-07 (UX_TODO INS-64). Every connect failure that was not a 401/403 came
// back as bad_token, "Could not validate the credential" — the admin behind an
// internal CA was told their token was wrong.

/** The shape octokit throws for a TRANSPORT failure: status 500, a request, no response. */
function transportError(code: string, message: string): Error {
  const root = Object.assign(new Error(message), { code });
  const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: root });
  return Object.assign(new Error(message), {
    status: 500,
    request: { method: 'GET', url: 'https://git.example.com/api/v1/user/repos' },
    cause: fetchFailed,
  });
}

describe('classifySmokeError (W20-07, INS-64)', () => {
  it('keeps bad_token for a real 401 only, and bad_scope for a 403', () => {
    expect(classifySmokeError({ status: 401 }).kind).toBe('bad_token');
    expect(classifySmokeError({ status: 403 }).kind).toBe('bad_scope');
  });

  it('calls an untrusted internal CA tls_untrusted, naming the host and the docs section', () => {
    const err = classifySmokeError(
      transportError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'),
      'git.example.com',
    );
    expect(err.kind).toBe('tls_untrusted');
    expect(err.message).toContain('git.example.com');
    expect(err.message).toContain('unable to get local issuer certificate');
    expect(err.message).toContain('internal-CA certificate');
  });

  it('calls DNS failures, refusals and timeouts cannot_reach with the underlying reason', () => {
    for (const [code, message] of [
      ['ENOTFOUND', 'getaddrinfo ENOTFOUND git.example.com'],
      ['ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:443'],
      ['UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'],
    ] as const) {
      const err = classifySmokeError(transportError(code, message), 'git.example.com');
      expect(err.kind, code).toBe('cannot_reach');
      expect(err.message, code).toContain(message);
      // The token was never judged, so the copy must not blame it.
      expect(err.message, code).not.toMatch(/token/i);
    }
  });

  it('calls a 404 wrong_url, and a forge 5xx answer cannot_reach with its status', () => {
    expect(classifySmokeError({ status: 404 }, 'git.example.com').kind).toBe('wrong_url');
    const fiveHundred = classifySmokeError(new ForgeHttpError(502, 'repos', null));
    expect(fiveHundred.kind).toBe('cannot_reach');
    expect(fiveHundred.message).toContain('HTTP 502');
  });

  it('never echoes userinfo from a URL in the reason', () => {
    const err = classifySmokeError(
      transportError('ENOTFOUND', 'getaddrinfo ENOTFOUND https://user:hunter2@git.example.com'),
    );
    expect(err.message).not.toContain('hunter2');
  });
});

// W20-07 (UX_TODO INS-52). The picker, the track call and the CLI read ONE page.
describe('collectAllPages (W20-07, INS-52)', () => {
  it('follows nextCursor until the forge stops returning one', async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      first: { items: [1, 2], nextCursor: 'p2' },
      p2: { items: [3], nextCursor: 'p3' },
      p3: { items: [4] },
    };
    const seen: (string | undefined)[] = [];
    const out = await collectAllPages<number, string>((cursor) => {
      seen.push(cursor);
      return Promise.resolve(pages[cursor ?? 'first']!);
    });
    expect(out).toEqual({ items: [1, 2, 3, 4], truncated: false });
    expect(seen).toEqual([undefined, 'p2', 'p3']);
  });

  it('stops at the page cap and says the list was cut, rather than looping forever', async () => {
    let calls = 0;
    const out = await collectAllPages<number, string>(() => {
      calls++;
      return Promise.resolve({ items: [calls], nextCursor: 'again' });
    });
    expect(calls).toBe(MAX_LISTING_PAGES);
    expect(out.truncated).toBe(true);
  });
});
