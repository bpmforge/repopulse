import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_LOGIN_GLOBS, isBotLogin } from './bots.js';

describe('isBotLogin (METRICS.md §0)', () => {
  it('matches the default bot globs', () => {
    expect(isBotLogin('renovate[bot]')).toBe(true);
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('dependabot')).toBe(true);
    expect(isBotLogin('renovate-staging')).toBe(true);
    expect(isBotLogin('github-actions[bot]')).toBe(true);
    expect(isBotLogin('some-app[bot]')).toBe(true);
  });

  it('does not match ordinary human logins', () => {
    expect(isBotLogin('octocat')).toBe(false);
    expect(isBotLogin('alice')).toBe(false);
    expect(isBotLogin('bot-enthusiast')).toBe(false); // contains "bot" but not the [bot] suffix
  });

  it('is case-insensitive', () => {
    expect(isBotLogin('RENOVATE[BOT]')).toBe(true);
  });

  it('honors a workspace-configured glob list over the default', () => {
    expect(isBotLogin('custom-ci', ['custom-*'])).toBe(true);
    expect(isBotLogin('renovate[bot]', ['custom-*'])).toBe(false);
  });

  it('exports exactly the four documented default globs', () => {
    expect(DEFAULT_BOT_LOGIN_GLOBS).toEqual([
      '*[bot]',
      'dependabot*',
      'renovate*',
      'github-actions*',
    ]);
  });
});
