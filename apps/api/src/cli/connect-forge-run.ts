import {
  classifySmokeError,
  collectAllPages,
  ConnectValidationError,
  type CandidateRepo,
  type RepoSelection,
} from '@repopulse/ingest';
import { splitRepoFullName, type ForgeCursor, type ForgeRepo, type Page } from '@repopulse/forge';

// The decision half of `pnpm connect:forge` (W20-07, UX_TODO INS-13), split
// from the process half (env, database, Redis) in connect-forge.ts so it can be
// tested without either.
//
// THE BUG IT FIXES: `--dry-run` was documented as "connects, lists… selects
// nothing", but it called createConnection first and listed afterwards, so it
// SAVED a connection. The documented follow-up, `--all`, then saved a second
// one (the CLI is deliberately not idempotent-by-token), and the operator had
// two connections to one organisation without ever asking for two.

export interface ConnectForgeArgs {
  all: boolean;
  /** `owner/name` entries from --repos. */
  repos: string[];
  dryRun: boolean;
}

export interface ConnectForgeDeps {
  /** One page of the token's repositories (the provider's listRepos). */
  listPage: (cursor?: ForgeCursor) => Promise<Page<ForgeRepo>>;
  /** Persist the connection; given the already-listed repos as its smoke result. */
  saveConnection: (
    smoke: () => Promise<ForgeRepo[]>,
  ) => Promise<{ connectionId: number; candidates: CandidateRepo[] }>;
  activate: (
    connectionId: number,
    candidates: CandidateRepo[],
    selection: RepoSelection,
  ) => Promise<number[]>;
  log: (line: string) => void;
  /** Named in a cannot-reach message (INS-64). */
  host?: string | undefined;
}

export type ConnectForgeOutcome =
  | { saved: false; visible: string[]; truncated: boolean }
  | { saved: true; connectionId: number; repoIds: number[]; truncated: boolean };

const plural = (n: number) => (n === 1 ? 'y' : 'ies');

export async function runConnectForge(
  args: ConnectForgeArgs,
  deps: ConnectForgeDeps,
): Promise<ConnectForgeOutcome> {
  // Every page (W20-07, INS-52): the first page alone hid every quiet repo of a
  // larger organisation from --repos and from --dry-run's listing.
  let listed: { items: ForgeRepo[]; truncated: boolean };
  try {
    listed = await collectAllPages<ForgeRepo, ForgeCursor>((cursor) => deps.listPage(cursor));
  } catch (err) {
    throw classifySmokeError(err, deps.host);
  }
  if (listed.items.length === 0) {
    throw new ConnectValidationError('no_repos', 'The credential can see no repositories.');
  }
  const names = listed.items.map((r) => {
    const { org, name } = splitRepoFullName(r.fullName, r.name);
    return `${org}/${name}`;
  });

  if (args.dryRun) {
    // Nothing is written: no connection, no repos, no queue. A dry run that
    // saves is not a dry run.
    deps.log(`\nthe credential can see ${names.length} repositor${plural(names.length)}`);
    if (listed.truncated) deps.log('(the forge kept paging; this list stops at the safety cap)');
    deps.log('\n--dry-run: nothing was saved and nothing was selected. Repositories:\n');
    for (const n of names) deps.log(`  ${n}`);
    deps.log('\nRe-run without --dry-run, with --all or --repos owner/name,owner/other');
    return { saved: false, visible: names, truncated: listed.truncated };
  }

  const result = await deps.saveConnection(() => Promise.resolve(listed.items));
  deps.log(`connection id ${result.connectionId}`);
  deps.log(
    `the credential can see ${result.candidates.length} repositor${plural(result.candidates.length)}`,
  );
  const repoIds = await deps.activate(
    result.connectionId,
    result.candidates,
    args.all
      ? { allAutoAdd: true }
      : {
          forgeRepoIds: result.candidates
            .filter((c) => args.repos.includes(`${c.org}/${c.name}`))
            .map((c) => c.forgeRepoId),
        },
  );
  return { saved: true, connectionId: result.connectionId, repoIds, truncated: listed.truncated };
}
