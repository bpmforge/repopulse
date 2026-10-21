import { describe, expect, it } from 'vitest';
import { ciRunsForgeUrl, type RepoForge } from './forge-links.js';

// W20-20 (UX_TODO DSH-29): a flaky workflow row opens its runs on the forge.

const forge = (
  kind: RepoForge['kind'],
  webBase: string | null = 'https://forge.test/',
): RepoForge => ({
  kind,
  webBase,
  org: 'acme',
  name: 'api',
  defaultBranch: 'main',
});

describe('ciRunsForgeUrl', () => {
  it('filters GitHub Actions by workflow name', () => {
    expect(ciRunsForgeUrl(forge('github'), 'CI build')).toBe(
      'https://forge.test/acme/api/actions?query=workflow%3A%22CI%20build%22',
    );
  });

  it('opens the runs list on Gitea and GitLab', () => {
    expect(ciRunsForgeUrl(forge('gitea'), 'ci')).toBe('https://forge.test/acme/api/actions');
    expect(ciRunsForgeUrl(forge('gitlab'), 'ci')).toBe('https://forge.test/acme/api/-/pipelines');
  });

  it('is null when the web root is unknown', () => {
    expect(ciRunsForgeUrl(forge('gitea', null), 'ci')).toBeNull();
    expect(ciRunsForgeUrl(null, 'ci')).toBeNull();
  });
});
