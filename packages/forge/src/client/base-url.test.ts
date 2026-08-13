import { describe, expect, it } from 'vitest';
import { ForgeSsrfError, validateBaseUrl } from './base-url.js';

const allowlist = ['api.github.com', 'gitea.internal.example.com'];

describe('validateBaseUrl (SC-12)', () => {
  it('accepts an allowlisted https hostname', () => {
    expect(() => validateBaseUrl('https://api.github.com/user', { allowlist })).not.toThrow();
  });

  it('is case-insensitive on the allowlist match', () => {
    expect(() => validateBaseUrl('https://API.GITHUB.COM/user', { allowlist })).not.toThrow();
  });

  it('rejects a non-https scheme', () => {
    expect(() => validateBaseUrl('http://api.github.com/user', { allowlist })).toThrow(
      ForgeSsrfError,
    );
  });

  it('rejects a hostname not on the allowlist', () => {
    expect(() => validateBaseUrl('https://evil.example.com/user', { allowlist })).toThrow(
      ForgeSsrfError,
    );
  });

  // Canonical evil-URL corpus (SC-12 *Verify* line).
  it('rejects the cloud metadata IP literal', () => {
    expect(() =>
      validateBaseUrl('https://169.254.169.254/latest/meta-data', { allowlist }),
    ).toThrow(ForgeSsrfError);
  });

  it('rejects a decimal-encoded IP literal', () => {
    // 2852039166 == 169.254.169.254
    expect(() => validateBaseUrl('https://2852039166/latest/meta-data', { allowlist })).toThrow(
      ForgeSsrfError,
    );
  });

  it('rejects an octal-encoded dotted IP literal', () => {
    // 0251.0376.0251.0376 == 169.254.169.254 (each octet in octal)
    expect(() => validateBaseUrl('https://0251.0376.0251.0376/', { allowlist })).toThrow(
      ForgeSsrfError,
    );
  });

  it('rejects a hex-encoded dotted IP literal', () => {
    expect(() => validateBaseUrl('https://0xa9.0xfe.0xa9.0xfe/', { allowlist })).toThrow(
      ForgeSsrfError,
    );
  });

  it('rejects localhost', () => {
    expect(() => validateBaseUrl('https://localhost/user', { allowlist })).toThrow(ForgeSsrfError);
  });

  it('rejects a *.localhost suffix (rebinding stub pattern)', () => {
    expect(() => validateBaseUrl('https://evil.localhost/user', { allowlist })).toThrow(
      ForgeSsrfError,
    );
  });

  it('rejects an IPv4 literal even when not in a sensitive range', () => {
    expect(() => validateBaseUrl('https://93.184.216.34/', { allowlist })).toThrow(ForgeSsrfError);
  });

  it('rejects a bracketed IPv6 literal', () => {
    expect(() => validateBaseUrl('https://[::1]/', { allowlist })).toThrow(ForgeSsrfError);
  });

  it('rejects a private RFC1918 IPv4 literal', () => {
    expect(() => validateBaseUrl('https://10.0.0.1/', { allowlist })).toThrow(ForgeSsrfError);
  });

  it('rejects a malformed URL', () => {
    expect(() => validateBaseUrl('not a url', { allowlist })).toThrow(ForgeSsrfError);
  });

  it('accepts a non-default port on an allowlisted host (self-hosted forge, D1a)', () => {
    // The allowlist holds a bare hostname; the URL carries :8443. Regression
    // guard for deriving the entry from URL.host (which includes the port) —
    // that made every non-443 self-hosted forge unreachable.
    expect(() =>
      validateBaseUrl('https://gitea.internal.example.com:8443/api/v1/repos', { allowlist }),
    ).not.toThrow();
  });
});

// The escape hatch is operator-set (FORGE_ALLOW_INSECURE_LOOPBACK), never user
// input. These tests pin how narrow it is: everything it does NOT relax matters
// more than the one thing it does.
describe('validateBaseUrl allowInsecureLoopback (SC-12 escape hatch)', () => {
  const loopback = ['127.0.0.1', 'localhost', '::1', 'api.github.com'];
  const opts = { allowlist: loopback, allowInsecureLoopback: true };

  it('accepts http on a loopback IPv4 literal when opted in', () => {
    expect(() => validateBaseUrl('http://127.0.0.1:9099/api/v3', opts)).not.toThrow();
  });

  it('accepts http on exact localhost when opted in', () => {
    expect(() => validateBaseUrl('http://localhost:9099/api/v3', opts)).not.toThrow();
  });

  it('accepts http on the IPv6 loopback when opted in', () => {
    expect(() => validateBaseUrl('http://[::1]:9099/api/v3', opts)).not.toThrow();
  });

  it('still rejects the same URL when NOT opted in (default is strict)', () => {
    expect(() => validateBaseUrl('http://127.0.0.1:9099/api/v3', { allowlist: loopback })).toThrow(
      ForgeSsrfError,
    );
  });

  it('does NOT relax a non-loopback host — the metadata IP stays rejected', () => {
    expect(() =>
      validateBaseUrl('http://169.254.169.254/latest/meta-data', {
        allowlist: [...loopback, '169.254.169.254'],
        allowInsecureLoopback: true,
      }),
    ).toThrow(ForgeSsrfError);
  });

  it('does NOT relax a private RFC1918 host', () => {
    expect(() =>
      validateBaseUrl('http://10.0.0.1/', {
        allowlist: [...loopback, '10.0.0.1'],
        allowInsecureLoopback: true,
      }),
    ).toThrow(ForgeSsrfError);
  });

  it('does NOT relax the *.localhost rebinding stub pattern', () => {
    expect(() =>
      validateBaseUrl('http://evil.localhost/', {
        allowlist: [...loopback, 'evil.localhost'],
        allowInsecureLoopback: true,
      }),
    ).toThrow(ForgeSsrfError);
  });

  it('treats a decimal-disguised loopback as loopback (2130706433 == 127.0.0.1)', () => {
    // WHATWG normalizes inet_aton forms before we see them — URL.hostname is
    // already "127.0.0.1" here. Accepting it grants nothing the hatch does not
    // already grant, because the target genuinely IS loopback. What matters is
    // that a disguise resolving somewhere ELSE stays rejected, which the
    // metadata-IP and RFC1918 cases above prove. Pinned so the normalization
    // behavior is a documented decision rather than an accident.
    expect(() =>
      validateBaseUrl('http://2130706433/', { allowlist: loopback, allowInsecureLoopback: true }),
    ).not.toThrow();
  });

  it('still enforces the allowlist — loopback alone is not enough', () => {
    expect(() =>
      validateBaseUrl('http://127.0.0.1/', {
        allowlist: ['api.github.com'],
        allowInsecureLoopback: true,
      }),
    ).toThrow(ForgeSsrfError);
  });

  it('leaves a non-loopback https host on its normal path', () => {
    expect(() => validateBaseUrl('https://api.github.com/user', opts)).not.toThrow();
  });
});
