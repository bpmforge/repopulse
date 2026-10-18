import { describe, expect, it } from 'vitest';
import {
  HostPolicyError,
  T2_REQUEST_HEADERS,
  containsCredentialMaterial,
  parseT2Config,
  validateHostUrl,
} from './hosts.js';

// SC-24 LM Studio boundary discipline (W6-08, T-20/T-21).

describe('the evil-URL corpus', () => {
  const rejected = [
    ['http://93.184.216.34:1234', 'public IPv4'],
    ['http://models.example.com:1234', 'public hostname'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata endpoint'],
    ['http://169.254.170.2', 'ECS task metadata'],
    ['file:///etc/passwd', 'non-http scheme'],
    ['ftp://192.168.1.10', 'non-http scheme on a private address'],
    ['not-a-url', 'unparseable'],
  ] as const;

  for (const [url, why] of rejected) {
    it(`rejects ${why}`, () => {
      expect(() => validateHostUrl(url)).toThrow(HostPolicyError);
    });
  }

  it('rejects the metadata endpoint even though it is link-local', () => {
    // The trap this test exists for: 169.254/16 is not routable, so a naive
    // "is it private?" check waves it through — and it is the single most
    // valuable SSRF target there is, handing out instance credentials to
    // anything that can make an HTTP request.
    expect(() => validateHostUrl('http://169.254.169.254:1234')).toThrow(/SSRF target/);
  });

  const accepted = [
    'http://192.168.13.48:1234',
    'http://10.0.0.5:1234/v1',
    'http://172.16.4.9:1234',
    'http://100.72.1.4:1234',
    'http://localhost:1234',
    'http://127.0.0.1:1234',
  ];
  for (const url of accepted) {
    it(`accepts private LAN address ${url}`, () => {
      expect(validateHostUrl(url).hostname.length).toBeGreaterThan(0);
    });
  }

  it('allows a public host ONLY when explicitly flagged', () => {
    // Deliberately awkward: a deployment that genuinely runs its model on a
    // public host should have to say so in config, where someone reviews it.
    expect(() => validateHostUrl('http://models.example.com:1234')).toThrow();
    expect(validateHostUrl('http://models.example.com:1234', { allowPublicHosts: true }).port).toBe('1234');
  });

  it('rejects a hostname by default even if it might resolve privately', () => {
    // Resolution happens later and elsewhere, and can change between
    // validation and use. A name that resolves privately today is not a
    // guarantee about tomorrow.
    expect(() => validateHostUrl('http://nas.local:1234')).toThrow(/private-range/);
  });
});

describe('config parsing', () => {
  it('validates every host in the list, not just the first', () => {
    expect(() =>
      parseT2Config({
        hosts: [
          { baseUrl: 'http://192.168.1.5:1234', modelSlot: 'a' },
          { baseUrl: 'http://evil.example.com:1234', modelSlot: 'b' },
        ],
      }),
    ).toThrow(HostPolicyError);
  });

  it('requires at least one host rather than defaulting to none', () => {
    expect(() => parseT2Config({ hosts: [] })).toThrow();
  });

  it('caps concurrency — an unbounded cap would queue a LAN box to death', () => {
    expect(() => parseT2Config({ hosts: [{ baseUrl: 'http://10.0.0.1:1234', modelSlot: 'a' }], concurrencyCap: 99 })).toThrow();
  });
});

describe('credential-free requests', () => {
  it('sends exactly one header, and it is not an auth header', () => {
    expect(Object.keys(T2_REQUEST_HEADERS)).toEqual(['content-type']);
    expect(JSON.stringify(T2_REQUEST_HEADERS).toLowerCase()).not.toContain('authorization');
  });

  it('the header set is frozen, so a later edit cannot quietly add one', () => {
    expect(Object.isFrozen(T2_REQUEST_HEADERS)).toBe(true);
  });

  it('detects credential material in an outbound payload', () => {
    expect(containsCredentialMaterial('{"authorization":"Bearer abc"}')).toBe(true);
    expect(containsCredentialMaterial('token: ghp_' + 'a'.repeat(20))).toBe(true);
    expect(containsCredentialMaterial('{"api_key": "x"}')).toBe(true);
    // A diff that merely MENTIONS the word must not trip it, or the guard
    // becomes noise and gets switched off.
    expect(containsCredentialMaterial('+ // renamed the password field')).toBe(false);
  });
});
