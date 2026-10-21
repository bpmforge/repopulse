import { and, eq } from 'drizzle-orm';
import { blobUrl, pullUrl, webBaseUrl, type ForgeKind } from '@repopulse/forge';
import { core, type Database } from '@repopulse/shared';

// Links OUT to the forge for the drill-down screens (W20-12, UX_TODO
// DSH-38/68).
//
// RepoPulse never stores source code (C1), so a lead reading a file's churn or
// a PR's stage times has to leave for the forge to see the thing itself — and
// had to find it by hand. These are string construction from our own rows
// (the repo and its connection's base URL); no forge call is made, so neither
// Law 4 nor the rate-limit budget is involved.

export interface RepoForge {
  kind: ForgeKind;
  /** The forge's WEB root; null when it cannot be known (a Gitea with no base). */
  webBase: string | null;
  org: string;
  name: string;
  defaultBranch: string;
}

/** The repository's forge facts, workspace-filtered (Law 5); null when not ours. */
export async function readRepoForge(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<RepoForge | null> {
  const [row] = await db
    .select({
      org: core.repos.org,
      name: core.repos.name,
      defaultBranch: core.repos.defaultBranch,
      provider: core.forgeConnections.provider,
      baseUrl: core.forgeConnections.baseUrl,
    })
    .from(core.repos)
    .innerJoin(core.forgeConnections, eq(core.repos.connectionId, core.forgeConnections.id))
    .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  const kind = row.provider as ForgeKind;
  return {
    kind,
    webBase: webBaseUrl(kind, row.baseUrl),
    org: row.org,
    name: row.name,
    defaultBranch: row.defaultBranch,
  };
}

/** The file on the default branch, or null when the forge's web root is unknown. */
export function fileForgeUrl(forge: RepoForge | null, path: string): string | null {
  if (!forge?.webBase) return null;
  return blobUrl({
    kind: forge.kind,
    baseUrl: forge.webBase,
    org: forge.org,
    repo: forge.name,
    path,
    ref: forge.defaultBranch,
    refKind: 'branch',
  });
}

/**
 * Where a workflow's runs are listed on the forge (W20-20, UX_TODO DSH-29), so
 * a flaky row opens the runs that made it flaky. GitHub filters its Actions
 * page by workflow name; Gitea and GitLab have no stable by-name filter in the
 * URL, so they open the repository's runs / pipelines list. Null when the web
 * root is unknown.
 */
export function ciRunsForgeUrl(forge: RepoForge | null, workflowName: string): string | null {
  if (!forge?.webBase) return null;
  const base = forge.webBase.replace(/\/+$/, '');
  const repoPath = `${encodeURIComponent(forge.org)}/${encodeURIComponent(forge.name)}`;
  switch (forge.kind) {
    case 'github':
      return `${base}/${repoPath}/actions?query=${encodeURIComponent(`workflow:"${workflowName}"`)}`;
    case 'gitea':
      return `${base}/${repoPath}/actions`;
    case 'gitlab':
      return `${base}/${repoPath}/-/pipelines`;
  }
}

/** The pull request's own page on the forge, or null when unknown. */
export function prForgeUrl(forge: RepoForge | null, number: number): string | null {
  if (!forge?.webBase) return null;
  return pullUrl({
    kind: forge.kind,
    baseUrl: forge.webBase,
    org: forge.org,
    repo: forge.name,
    number,
  });
}
