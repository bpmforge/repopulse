import { describe, expect, it } from 'vitest';
import { githubApiBase } from '../src/github/provider.js';

// W20-22 (UX_TODO INS-59): a GitHub Enterprise Server address typed as the
// browser address gets the /api/v3 REST root, like Gitea's /api/v1 and
// GitLab's /api/v4.
describe('githubApiBase', () => {
  it('adds /api/v3 to a bare GitHub Enterprise Server address', () => {
    expect(githubApiBase('https://ghe.example.com')).toBe('https://ghe.example.com/api/v3');
    expect(githubApiBase('https://ghe.example.com/')).toBe('https://ghe.example.com/api/v3');
  });

  it('keeps an address that already names a path', () => {
    expect(githubApiBase('https://ghe.example.com/api/v3/')).toBe('https://ghe.example.com/api/v3');
    expect(githubApiBase('https://proxy.example.com/github')).toBe(
      'https://proxy.example.com/github',
    );
  });

  it('keeps github.com’s API host and loopback fake forges as typed', () => {
    expect(githubApiBase('https://api.github.com')).toBe('https://api.github.com');
    expect(githubApiBase('http://127.0.0.1:4010')).toBe('http://127.0.0.1:4010');
    expect(githubApiBase('http://localhost:4010/')).toBe('http://localhost:4010');
  });
});
