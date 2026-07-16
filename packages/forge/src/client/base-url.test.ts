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
});
