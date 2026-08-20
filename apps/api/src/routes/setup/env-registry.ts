// The env-var registry (W11-02, FR-DEPLOY-*).
//
// ONE source of truth for three things that used to be three: what the app
// reads, what docs/CONFIG.md says it reads, and what the startup check
// enforces. A doc maintained by hand beside code that changes is a doc that is
// wrong within a month, and the customer reading it is on their own
// infrastructure where we cannot see what they set.
//
// A test greps the source for environment reads and fails if any of them is
// missing from this list — so adding a variable without documenting it breaks
// the build rather than shipping quietly. (That grep is why this comment
// describes the two read forms instead of spelling them out: a literal example
// here would match its own gate.)

export type EnvScope = 'api' | 'worker' | 'web' | 'shared';

export interface EnvVar {
  name: string;
  scope: EnvScope;
  required: boolean;
  purpose: string;
  /** What goes wrong when it is absent or wrong — the useful half. */
  ifWrong: string;
  default?: string;
  /** Never logged, never returned by the setup endpoint. */
  secret?: boolean;
  /** Optional format check, run at startup. Returns an error message or null. */
  validate?: (value: string) => string | null;
}

const isUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : 'must be an http:// or https:// URL';
  } catch {
    return 'must be a valid absolute URL';
  }
};

const isPostgresUrl = (value: string): string | null =>
  /^postgres(ql)?:\/\//.test(value) ? null : 'must start with postgres:// or postgresql://';

const isRedisUrl = (value: string): string | null =>
  /^rediss?:\/\//.test(value) ? null : 'must start with redis:// or rediss://';

const isHex32 = (value: string): string | null =>
  /^[0-9a-fA-F]{64}$/.test(value)
    ? null
    : 'must be 32 bytes of hex (64 characters) — generate with: openssl rand -hex 32';

const minLength = (n: number) => (value: string) =>
  value.length >= n ? null : `must be at least ${n} characters`;

const isCron = (value: string): string | null =>
  value === 'off' || value.trim().split(/\s+/).length === 5
    ? null
    : "must be a 5-field cron expression, or the literal 'off' to disable";

export const ENV_REGISTRY: readonly EnvVar[] = [
  {
    name: 'DATABASE_URL',
    scope: 'shared',
    required: true,
    purpose: 'Postgres 16 connection string. Every read and write goes here.',
    ifWrong: 'The API and worker refuse to start. A wrong database means an empty product, not an error page.',
    validate: isPostgresUrl,
    secret: true,
  },
  {
    name: 'REDIS_URL',
    scope: 'shared',
    required: true,
    purpose: 'Redis connection for sessions and the BullMQ queues.',
    ifWrong: 'The API refuses to start; without it nothing is ingested and nobody can log in.',
    validate: isRedisUrl,
    secret: true,
  },
  {
    name: 'SESSION_SECRET',
    scope: 'api',
    required: true,
    purpose: 'Signs session cookies.',
    ifWrong: 'Changing it logs every user out. A short or shared value makes sessions forgeable.',
    validate: minLength(32),
    secret: true,
  },
  {
    name: 'TOKEN_ENC_KEY',
    scope: 'api',
    required: true,
    purpose: 'AES-256-GCM key encrypting forge tokens at rest (Law 9).',
    ifWrong:
      'Boot fails unless it is 32 bytes of hex. LOSING IT makes every stored forge credential undecryptable — they must be re-entered.',
    validate: isHex32,
    secret: true,
  },
  {
    name: 'API_BASE_URL',
    scope: 'api',
    required: true,
    purpose: 'Where the API is reachable. Builds the OAuth callback URL.',
    ifWrong:
      'OAuth fails after the forge redirects back, because the callback it was told about does not match this.',
    validate: isUrl,
  },
  {
    name: 'PUBLIC_BASE_URL',
    scope: 'api',
    required: true,
    purpose: 'Where users reach the web app. Builds the webhook URL and the post-login redirect.',
    ifWrong: 'Webhooks are registered against the wrong host and deliveries never arrive.',
    validate: isUrl,
  },
  {
    name: 'GITHUB_APP_CLIENT_ID',
    scope: 'api',
    required: true,
    purpose: 'OAuth client id of YOUR GitHub App (see docs/INSTALL.md).',
    ifWrong: 'Login fails at the forge with an unhelpful "application not found".',
  },
  {
    name: 'GITHUB_APP_CLIENT_SECRET',
    scope: 'api',
    required: true,
    purpose: 'OAuth client secret of your GitHub App.',
    ifWrong: 'Login fails at the token exchange, after the user has already approved.',
    secret: true,
  },
  {
    name: 'GITHUB_APP_ID',
    scope: 'api',
    required: false,
    purpose: 'Numeric App id, used for App-authenticated (installation) calls.',
    ifWrong: 'App-token flows are unavailable; PAT connections still work.',
  },
  {
    name: 'FORGE_BASE_URL',
    scope: 'api',
    required: false,
    purpose: 'Self-hosted Gitea base URL. Absent means github.com.',
    ifWrong: 'Gitea connections point at the wrong host and every sync fails with 404s.',
    validate: isUrl,
  },
  {
    name: 'FORGE_ALLOW_INSECURE_LOOPBACK',
    scope: 'api',
    required: false,
    purpose: 'Permits an http:// loopback forge URL. FOR LOCAL DEVELOPMENT ONLY.',
    ifWrong: 'Set in production, it allows an unencrypted forge connection.',
    default: 'unset',
  },
  {
    name: 'PORT',
    scope: 'api',
    required: false,
    purpose: 'API listen port.',
    ifWrong: 'The reverse proxy cannot reach the API.',
    default: '3300',
  },
  {
    name: 'NODE_ENV',
    scope: 'shared',
    required: false,
    purpose: "Set to 'production' in a real install: it turns on secure cookies.",
    ifWrong: 'Left unset behind TLS, session cookies are sent without the Secure flag.',
    default: 'development',
  },
  {
    name: 'WORKER_HEALTH_PORT',
    scope: 'worker',
    required: false,
    purpose: 'Port for the worker /healthz endpoint.',
    ifWrong: 'Container health checks fail and the orchestrator restarts a healthy worker.',
    default: '3301',
  },
  {
    name: 'DATA_DIR',
    scope: 'shared',
    required: false,
    purpose: 'Writable directory for generated reports.',
    ifWrong: 'Report generation fails at write time, after doing all the work.',
    default: './data',
  },
  {
    name: 'SNAPSHOT_ROOT',
    scope: 'worker',
    required: false,
    purpose: 'Scratch directory for C1a scan snapshots. Cleared by the sweeper.',
    ifWrong: 'Scans fail to extract; a non-ephemeral path retains customer source longer than intended.',
    default: 'the system temp directory',
  },
  {
    name: 'SCAN_IMAGE',
    scope: 'worker',
    required: false,
    purpose: 'Container image the sandboxed scanners run in.',
    ifWrong: 'Every tool-based scan fails to start; findings silently stop appearing.',
    default: 'localhost/repopulse/scan:dev',
  },
  {
    name: 'RECONCILE_CRON',
    scope: 'worker',
    required: false,
    purpose: "Nightly reconcile sweep schedule. 'off' disables it.",
    ifWrong: 'Drift between the forge and the warehouse is never corrected.',
    default: '17 3 * * *',
    validate: isCron,
  },
  {
    name: 'SECRETS_HISTORY_CRON',
    scope: 'worker',
    required: false,
    purpose: "Monthly secrets history sweep. 'off' disables it.",
    ifWrong: 'Credentials committed and later deleted are never found.',
    default: '23 4 1 * *',
    validate: isCron,
  },
  {
    name: 'SECURITY_WEEKLY_CRON',
    scope: 'worker',
    required: false,
    purpose: "Weekly full security and code-health pass. 'off' disables it.",
    ifWrong: 'Findings only ever come from pull requests, so unchanged code is never reviewed.',
    default: '41 2 * * 0',
    validate: isCron,
  },
  {
    name: 'SECURITY_CHAIN_CRON',
    scope: 'worker',
    required: false,
    purpose: 'Attack-chain recompute, deliberately an hour after the weekly pass.',
    ifWrong: 'Chains are built from findings the weekly scan is about to replace.',
    default: '41 3 * * 0',
    validate: isCron,
  },
  {
    name: 'REGISTERS_NIGHTLY_CRON',
    scope: 'worker',
    required: false,
    purpose: "Nightly W10 register pass (knowledge, supply chain, architecture, test gap). 'off' disables it.",
    ifWrong: 'Register findings never refresh; EOL dates in particular go stale silently.',
    default: '17 3 * * *',
    validate: isCron,
  },
  {
    name: 'EOL_PRODUCTS',
    scope: 'worker',
    required: false,
    purpose: 'Comma-separated endoflife.date products the nightly sync tracks.',
    ifWrong: 'A runtime you use is not tracked, so no EOL finding is ever raised for it.',
    default: 'nodejs,python,go,ruby,php,java,dotnet,debian,ubuntu,alpine,postgresql,redis,nginx',
  },
  {
    name: 'API_PROXY_TARGET',
    scope: 'web',
    required: false,
    purpose: 'Dev-server proxy target for /api. Not used in a container install.',
    ifWrong: 'The dev server cannot reach the API; production uses nginx instead.',
    default: 'http://localhost:3300',
  },
  {
    name: 'DEMO_GITHUB_PORT',
    scope: 'api',
    required: false,
    purpose: 'Port for the demo-mode fake GitHub. Development only.',
    ifWrong: 'Demo mode fails to start. Not read in a normal install.',
    default: '4010',
  },
  {
    name: 'DEMO_FORGE_PORT',
    scope: 'api',
    required: false,
    purpose: 'Port for the demo-mode fake forge. Development only.',
    ifWrong: 'Demo mode fails to start. Not read in a normal install.',
    default: '4011',
  },
];

export interface EnvProblem {
  name: string;
  reason: string;
}

/**
 * Validates the environment against the registry.
 *
 * Returns EVERY problem rather than throwing on the first: an operator filling
 * in a .env wants the whole list, not one variable per restart cycle.
 */
export function validateEnv(
  env: NodeJS.ProcessEnv,
  scopes: readonly EnvScope[] = ['api', 'shared'],
): EnvProblem[] {
  const problems: EnvProblem[] = [];

  for (const entry of ENV_REGISTRY) {
    if (!scopes.includes(entry.scope)) continue;
    const value = env[entry.name];

    if (value === undefined || value === '') {
      if (entry.required) {
        problems.push({ name: entry.name, reason: `is required — ${entry.purpose}` });
      }
      continue;
    }

    const failure = entry.validate?.(value);
    if (failure) problems.push({ name: entry.name, reason: failure });
  }

  return problems;
}

/** One message naming every variable, for a startup failure an operator can act on. */
export function formatEnvProblems(problems: readonly EnvProblem[]): string {
  return [
    `RepoPulse cannot start: ${problems.length} configuration problem${problems.length === 1 ? '' : 's'}.`,
    ...problems.map((problem) => `  - ${problem.name} ${problem.reason}`),
    '',
    'Every variable is documented in docs/CONFIG.md, with what breaks when it is wrong.',
  ].join('\n');
}
