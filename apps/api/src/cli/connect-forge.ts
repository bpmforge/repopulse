import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  activateRepos,
  createConnection,
  ConnectValidationError,
  createQueue,
  QUEUE,
  createRedisConnection,
} from '@repopulse/ingest';
import { buildDiscoveryProvider, type ForgeKind } from '../routes/connections/provider-factory.js';

// Headless forge connect (W14-01).
//
// WHY THIS EXISTS, and it is not only convenience: the ONLY way into the web
// UI is GitHub OAuth, so an operator whose GitHub App is not registered yet
// cannot reach the Connections screen at all — including to connect a GITEA
// organisation, which has nothing to do with GitHub. A self-hosted product
// whose first setup step is unreachable without a second vendor's approval is
// a product that cannot be bootstrapped. This is the door for that case.
//
// THE TOKEN IS READ FROM THE ENVIRONMENT, NEVER FROM ARGV. An argument lands
// in shell history and in `ps` output for every user on the box; an env var
// passed on the command line is at least confined to the process. It is
// encrypted with TOKEN_ENC_KEY through the same vault helper the API uses —
// no second implementation of credential handling — and this process never
// prints it, logs it, or writes it anywhere but the encrypted column.
//
//   FORGE_TOKEN=... pnpm connect:forge --provider gitea \
//     --base-url https://git.example.com --all
//
// It is deliberately NOT idempotent-by-token: re-running with a different
// credential creates a second connection rather than silently replacing one,
// because "the token changed" and "there are two organisations" look identical
// from here and only one of them is safe to assume.

interface Args {
  provider: ForgeKind;
  baseUrl?: string;
  workspace: string;
  all: boolean;
  repos: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const provider = (get('--provider') ?? 'gitea') as ForgeKind;
  const repos = (get('--repos') ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');

  return {
    provider,
    ...(get('--base-url') ? { baseUrl: get('--base-url')! } : {}),
    workspace: get('--workspace') ?? 'default',
    all: argv.includes('--all'),
    repos,
    dryRun: argv.includes('--dry-run'),
  };
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

// Read once, hold in one place, never widen its scope.
const token = process.env.FORGE_TOKEN ?? '';
if (token.trim() === '') {
  fail(
    [
      'FORGE_TOKEN is not set.',
      '',
      '  Gitea:  Settings → Applications → Generate New Token,',
      '          scopes read:repository, read:organization, read:user',
      '  GitHub: a personal access token with repo read access',
      '',
      'Pass it in the environment, not as an argument — an argument is visible',
      'in shell history and in ps output:',
      '',
      '  FORGE_TOKEN=... pnpm connect:forge --provider gitea \\',
      '    --base-url https://git.example.com --all',
    ].join('\n'),
  );
}

if (args.provider === 'gitea' && !args.baseUrl && !process.env.FORGE_BASE_URL) {
  fail('Gitea is self-hosted: pass --base-url https://your-instance, or set FORGE_BASE_URL.');
}
if (!args.all && args.repos.length === 0 && !args.dryRun) {
  fail('Choose repositories with --all, or --repos owner/name,owner/other. Use --dry-run to list them first.');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is required (see docs/CONFIG.md).');

const db = createDb(databaseUrl);
const tokenKey = credentials.loadTokenKey();
const baseUrl = args.baseUrl ?? process.env.FORGE_BASE_URL;

const [workspace] = await db
  .select({ id: core.workspaces.id })
  .from(core.workspaces)
  .where(eq(core.workspaces.slug, args.workspace))
  .limit(1);
if (!workspace) fail(`No workspace with slug "${args.workspace}". Run the migrations and seed first.`);

// The connection has to be attributed to somebody. A bootstrap run predates
// any human sign-in, so it records an explicit operator account rather than
// borrowing a real user's identity — an audit row naming a person who was not
// there is worse than one naming the process that did it.
const [operator] = await db
  .insert(core.users)
  .values({ authProvider: 'github', authSubject: 'repopulse:bootstrap', forgeUserId: 'repopulse:bootstrap', login: 'repopulse-bootstrap' })
  .onConflictDoUpdate({
    target: core.users.forgeUserId,
    set: { login: 'repopulse-bootstrap' },
  })
  .returning();

const provider = buildDiscoveryProvider({ kind: 'pat', token }, baseUrl, args.provider);

try {
  const result = await createConnection(
    {
      db,
      encrypt: (plaintext) => credentials.encryptCredential(plaintext, tokenKey),
      smokeListRepos: () => provider.listRepos({ lane: 'user' }).then((page) => page.items),
    },
    {
      workspaceId: workspace.id,
      provider: args.provider,
      authKind: 'pat',
      credential: token,
      createdBy: operator!.id,
      ...(baseUrl ? { baseUrl } : {}),
    },
  );

  console.log(`\nconnected: ${args.provider}${baseUrl ? ` at ${baseUrl}` : ''}`);
  console.log(`connection id ${result.connectionId}, fingerprint ${credentials.credentialFingerprint(token)}`);
  console.log(`the credential can see ${result.candidates.length} repositor${result.candidates.length === 1 ? 'y' : 'ies'}`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was selected. Repositories visible to this token:\n');
    for (const c of result.candidates) console.log(`  ${c.org}/${c.name}`);
    console.log('\nRe-run with --all, or --repos owner/name,owner/other');
    await db.$client.end();
    process.exit(0);
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) fail('REDIS_URL is required to enqueue the backfill.');
  const connection = createRedisConnection(redisUrl);
  const backfill = createQueue(QUEUE.backfill, connection);

  const repoIds = await activateRepos(
    {
      db,
      sealSecret: (plaintext) => credentials.sealSecret(plaintext, tokenKey),
      // Webhook registration is best-effort in activateRepos and stays that
      // way here: a bootstrap from a laptop usually cannot receive deliveries
      // anyway, and the reconcile cron covers the gap.
      registerWebhook: async () => '',
      enqueuePlan: async (repoId) => {
        await backfill.add('plan', { workspaceId: workspace.id, repoId });
      },
      // Same construction the connections route uses (32 random bytes, hex).
      generateSecret: () => randomBytes(32).toString('hex'),
    },
    {
      workspaceId: workspace.id,
      connectionId: result.connectionId,
      candidates: result.candidates,
      selection: args.all
        ? { allAutoAdd: true }
        : { forgeRepoIds: result.candidates.filter((c) => args.repos.includes(`${c.org}/${c.name}`)).map((c) => c.forgeRepoId) },
    },
  );

  console.log(`\nselected ${repoIds.length} repositor${repoIds.length === 1 ? 'y' : 'ies'}; backfill enqueued`);
  console.log('The worker drains it — watch: podman logs -f repopulse_worker_1\n');

  await backfill.close();
  await connection.quit();
  await db.$client.end();
} catch (error) {
  if (error instanceof ConnectValidationError) {
    // bad_token / bad_scope / no_repos — the three answers that are actually
    // actionable, kept distinct here exactly as the API keeps them.
    fail(`The forge rejected this credential (${error.kind}): ${error.message}`);
  }
  throw error;
}
