import { describe, expect, it, vi } from 'vitest';
import type { ForgeRepo } from '@repopulse/forge';
import { runConnectForge, type ConnectForgeDeps } from './connect-forge-run.js';

// W20-07 (UX_TODO INS-13). `--dry-run` saved a connection, and the documented
// follow-up `--all` then saved a second one to the same organisation.

const repo = (id: string, fullName: string): ForgeRepo => ({
  externalId: id,
  name: fullName.split('/').at(-1)!,
  fullName,
  defaultBranch: 'main',
  isPrivate: true,
  isArchived: false,
  pushedAt: null,
  htmlUrl: '',
});

function deps(over: Partial<ConnectForgeDeps> = {}) {
  const pages: Record<string, { items: ForgeRepo[]; nextCursor?: string }> = {
    first: { items: [repo('1', 'acme/alpha')], nextCursor: 'p2' },
    // INS-52: the second page used to be invisible to --repos and --dry-run.
    p2: { items: [repo('2', 'acme/quiet')] },
  };
  const saveConnection = vi.fn(async (smoke: () => Promise<ForgeRepo[]>) => {
    const items = await smoke();
    return {
      connectionId: 7,
      candidates: items.map((r) => ({
        forgeRepoId: r.externalId,
        org: 'acme',
        name: r.name,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        pushedAt: null,
      })),
    };
  });
  const activate = vi.fn(async (_id: number, _c: unknown, _s: unknown) => [11]);
  const lines: string[] = [];
  const d: ConnectForgeDeps = {
    listPage: (cursor) => Promise.resolve(pages[cursor ?? 'first']!),
    saveConnection,
    activate,
    log: (l) => lines.push(l),
    ...over,
  };
  return { d, saveConnection, activate, lines };
}

describe('connect:forge (W20-07, INS-13)', () => {
  it('--dry-run lists every page and saves nothing', async () => {
    const { d, saveConnection, activate, lines } = deps();
    const out = await runConnectForge({ all: false, repos: [], dryRun: true }, d);
    expect(out).toMatchObject({ saved: false, visible: ['acme/alpha', 'acme/quiet'] });
    expect(saveConnection).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('nothing was saved');
  });

  it('a real run saves once and can select a repo from a later page', async () => {
    const { d, saveConnection, activate } = deps();
    const out = await runConnectForge({ all: false, repos: ['acme/quiet'], dryRun: false }, d);
    expect(out).toMatchObject({ saved: true, connectionId: 7, repoIds: [11] });
    expect(saveConnection).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]![2]).toEqual({ forgeRepoIds: ['2'] });
  });

  it('reports an unreachable forge as cannot_reach, not as a bad token', async () => {
    const { d } = deps({
      listPage: () =>
        Promise.reject(
          Object.assign(new Error('getaddrinfo ENOTFOUND git.example.com'), {
            status: 500,
            request: {},
            cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND git.example.com' },
          }),
        ),
      host: 'git.example.com',
    });
    await expect(runConnectForge({ all: true, repos: [], dryRun: true }, d)).rejects.toMatchObject({
      kind: 'cannot_reach',
    });
  });
});
