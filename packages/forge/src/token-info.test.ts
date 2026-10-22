import { describe, expect, it } from 'vitest';
import {
  headerOf,
  loginOf,
  parseGithubTokenExpiration,
  parseGitlabTokenExpiry,
} from './token-info.js';

describe('parseGithubTokenExpiration (W20-25, ADM-50)', () => {
  it('reads the UTC, numeric-offset and ISO forms', () => {
    expect(parseGithubTokenExpiration('2026-11-30 12:00:00 UTC')?.toISOString()).toBe(
      '2026-11-30T12:00:00.000Z',
    );
    expect(parseGithubTokenExpiration('2026-11-30 12:00:00 +0700')?.toISOString()).toBe(
      '2026-11-30T05:00:00.000Z',
    );
    expect(parseGithubTokenExpiration('2026-11-30T12:00:00Z')?.toISOString()).toBe(
      '2026-11-30T12:00:00.000Z',
    );
  });

  it('is null for a missing or unreadable header', () => {
    expect(parseGithubTokenExpiration(undefined)).toBeNull();
    expect(parseGithubTokenExpiration('')).toBeNull();
    expect(parseGithubTokenExpiration('next tuesday')).toBeNull();
  });
});

describe('parseGitlabTokenExpiry', () => {
  it('reads a date as the start of that UTC day, and null as never', () => {
    expect(parseGitlabTokenExpiry('2026-12-31')?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(parseGitlabTokenExpiry(null)).toBeNull();
    expect(parseGitlabTokenExpiry('soon')).toBeNull();
  });
});

describe('loginOf / headerOf', () => {
  it('reads the named field only', () => {
    expect(loginOf({ login: 'ada' }, 'login')).toBe('ada');
    expect(loginOf({ username: 'ada' }, 'login')).toBeNull();
    expect(loginOf(null, 'username')).toBeNull();
  });

  it('finds a header whatever its case', () => {
    expect(
      headerOf(
        { 'GitHub-Authentication-Token-Expiration': 'x' },
        'github-authentication-token-expiration',
      ),
    ).toBe('x');
    expect(headerOf({}, 'a')).toBeNull();
  });
});
