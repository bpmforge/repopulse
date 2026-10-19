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
import {
  buildDiscoveryProvider,
  resolveConnectionBaseUrl,
  type ForgeKind,
} from '../routes/connections/provider-factory.js';
import { runConnectForge } from './connect-forge-run.js';

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
  fail(
    'Choose repositories with --all, or --repos owner/name,owner/other. Use --dry-run to list them first.',
  );
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is required (see docs/CONFIG.md).');

const db = createDb(databaseUrl);
const tokenKey = credentials.loadTokenKey();
// By forge kind, the same way the API decides it (W20-07, UX_TODO INS-73).
const baseUrl = resolveConnectionBaseUrl(args.provider, args.baseUrl, process.env.FORGE_BASE_URL);

const [workspace] = await db
  .select({ id: core.workspaces.id })
  .from(core.workspaces)
  .where(eq(core.workspaces.slug, args.workspace))
  .limit(1);
if (!workspace)
  fail(`No workspace with slug "${args.workspace}". Run the migrations and seed first.`);

// The connection has to be attributed to somebody. A bootstrap run predates
// any human sign-in, so it records an explicit operator account rather than
// borrowing a real user's identity — an audit row naming a person who was not
// there is worse than one naming the process that did it. Created only when a
// connection is actually saved: a dry run writes nothing at all (INS-13).
async function operatorId(): Promise<number> {
  const [operator] = await db
    .insert(core.users)
    .values({
      authProvider: 'github',
      authSubject: 'repopulse:bootstrap',
      forgeUserId: 'repopulse:bootstrap',
      login: 'repopulse-bootstrap',
    })
    .onConflictDoUpdate({
      target: core.users.forgeUserId,
      set: { login: 'repopulse-bootstrap' },
    })
    .returning();
  return operator!.id;
}

const provider = buildDiscoveryProvider({ kind: 'pat', token }, baseUrl, args.provider);

// Opened only when something is actually queued: a dry run never touches Redis.
let backfill: ReturnType<typeof createQueue> | undefined;
let redis: ReturnType<typeof createRedisConnection> | undefined;

try {
  const outcome = await runConnectForge(args, {
    listPage: (cursor) => provider.listRepos({ lane: 'user' }, cursor),
    host: baseUrl ? new URL(baseUrl).host : undefined,
    log: (line) => console.log(line),
    saveConnection: async (smoke) => {
      const result = await createConnection(
        {
          db,
          encrypt: (plaintext) => credentials.encryptCredential(plaintext, tokenKey),
          smokeListRepos: smoke,
        },
        {
          workspaceId: workspace.id,
          provider: args.provider,
          authKind: 'pat',
          credential: token,
          createdBy: await operatorId(),
          ...(baseUrl ? { baseUrl } : {}),
        },
      );
      console.log(`\nconnected: ${args.provider}${baseUrl ? ` at ${baseUrl}` : ''}`);
      console.log(`fingerprint ${credentials.credentialFingerprint(token)}`);
      return result;
    },
    activate: async (connectionId, candidates, selection) => {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) fail('REDIS_URL is required to enqueue the backfill.');
      redis = createRedisConnection(redisUrl);
      const queue = createQueue(QUEUE.backfill, redis);
      backfill = queue;
      return activateRepos(
        {
          db,
          sealSecret: (plaintext) => credentials.sealSecret(plaintext, tokenKey),
          openSecret: (sealed) => credentials.openSecret(sealed, tokenKey),
          // Webhook registration is best-effort in activateRepos and stays that
          // way here: a bootstrap from a laptop usually cannot receive
          // deliveries anyway, and the reconcile cron covers the gap.
          registerWebhook: async () => '',
          enqueuePlan: async (repoId) => {
            await queue.add('plan', { workspaceId: workspace.id, repoId });
          },
          // Same construction the connections route uses (32 random bytes, hex).
          generateSecret: () => randomBytes(32).toString('hex'),
        },
        { workspaceId: workspace.id, connectionId, candidates, selection },
      );
    },
  });

  if (outcome.saved) {
    const n = outcome.repoIds.length;
    console.log(`\nselected ${n} repositor${n === 1 ? 'y' : 'ies'}; backfill enqueued`);
    console.log('Watch it land in Settings → Sync.\n');
  }
  await backfill?.close();
  await redis?.quit();
  await db.$client.end();
} catch (error) {
  if (error instanceof ConnectValidationError) {
    // Each kind is actionable on its own (bad_token / bad_scope / no_repos,
    // and since W20-07 wrong_url / tls_untrusted / cannot_reach), kept
    // distinct here exactly as the API keeps them.
    fail(`The connection failed (${error.kind}): ${error.message}`);
  }
  throw error;
}
