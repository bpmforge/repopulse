import { describe, expect, it } from 'vitest';
import { connectionHost } from './host.js';

describe('connectionHost', () => {
  it('names the default host of a provider that has no base URL', () => {
    expect(connectionHost('github', null)).toBe('github.com');
    expect(connectionHost('gitlab', null)).toBe('gitlab.com');
    // Gitea is always self-hosted: with no base URL there is nothing honest to say.
    expect(connectionHost('gitea', null)).toBeNull();
  });

  it('shows the product name for GitHub’s API host, and the host itself otherwise', () => {
    expect(connectionHost('github', 'https://api.github.com')).toBe('github.com');
    expect(connectionHost('gitea', 'https://git.corp.example:8443/')).toBe('git.corp.example');
    expect(connectionHost('github', 'https://ghe.corp.example/api/v3')).toBe('ghe.corp.example');
  });

  it('is null for a base URL that is not a URL, rather than guessing', () => {
    expect(connectionHost('github', 'not a url')).toBeNull();
  });
});
