import { describe, expect, it } from 'vitest';
import { postLoginUrl, safeReturnTo } from './return-to.js';

// W20-10 (UX_TODO X-01): return_to is an open-redirect surface; only a path
// on our own origin survives.
describe('safeReturnTo', () => {
  it('keeps a same-origin path with its query and hash', () => {
    expect(safeReturnTo('/findings?finding=812')).toBe('/findings?finding=812');
    expect(safeReturnTo('/repos/4/security#deps')).toBe('/repos/4/security#deps');
  });

  it.each([
    ['absolute URL', 'https://evil.example/x'],
    ['protocol-relative', '//evil.example/x'],
    ['backslash trick', '/\\evil.example'],
    ['tab inside', '/\t/evil.example'],
    ['newline inside', '/x\nSet-Cookie: a=b'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['relative path', 'findings'],
    ['the root', '/'],
    ['the login route', '/auth/login'],
    ['the api', '/api/v1/me'],
    ['empty', ''],
    ['too long', `/${'a'.repeat(2048)}`],
  ])('drops %s', (_name, raw) => {
    expect(safeReturnTo(raw)).toBeNull();
  });

  it('drops a non-string', () => {
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo(['/findings'])).toBeNull();
  });

  it('keeps a path that merely starts with the letters auth', () => {
    expect(safeReturnTo('/authors')).toBe('/authors');
  });
});

describe('postLoginUrl', () => {
  it('lands on the SPA origin', () => {
    expect(postLoginUrl('https://rp.example/', '/findings?finding=1')).toBe(
      'https://rp.example/findings?finding=1',
    );
  });
  it('falls back to the configured URL without a return path', () => {
    expect(postLoginUrl('https://rp.example/', null)).toBe('https://rp.example/');
  });
});
