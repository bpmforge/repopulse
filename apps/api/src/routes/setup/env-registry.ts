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
    ifWrong:
      'The API and worker refuse to start. A wrong database means an empty product, not an error page.',
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
    required: false,
    purpose:
      'OAuth client id of YOUR GitHub App. OPTIONAL since D14 — set it only if you want "Sign in with GitHub" offered alongside local accounts and OIDC.',
    ifWrong:
      'Forge sign-in is not offered at all when it is absent, which is a supported deployment. Set but wrong, login fails at GitHub with an unhelpful "application not found".',
  },
  {
    name: 'GITHUB_APP_CLIENT_SECRET',
    scope: 'api',
    required: false,
    purpose:
      'OAuth client secret of your GitHub App. Required only alongside GITHUB_APP_CLIENT_ID.',
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
    purpose:
      'Fallback forge base URL for a connection saved without one. Each connection stores its own kind and base URL (Admin → Connections), so this is optional. Absent means github.com.',
    ifWrong:
      'Only connections with no stored base URL are affected: they point at the wrong host and every sync fails with 404s.',
    validate: isUrl,
  },
  {
    name: 'ADMIN_EMAIL',
    scope: 'api',
    required: false,
    purpose:
      'Email of the first admin account, created on first boot (D14). Without it — and with no other local account — a fresh install has no way in.',
    ifWrong:
      'A typo creates an admin nobody can sign in as. The bootstrap is idempotent on "any local account with a password exists", so correcting the value later does NOT create a second admin; use the admin user-creation route instead.',
  },
  {
    name: 'ADMIN_PASSWORD',
    scope: 'api',
    required: false,
    purpose:
      'Password for that first admin. It must be changed at first sign-in before anything else is reachable.',
    ifWrong:
      'Boot FAILS on a password below the minimum length rather than creating a weak admin. Leaving it set afterwards is inert — bootstrap never overwrites a password that has been changed — but remove it anyway; a live credential in a file is a live credential.',
    secret: true,
  },
  {
    name: 'OIDC_ISSUER',
    scope: 'api',
    required: false,
    purpose:
      'Issuer URL of your identity provider, e.g. https://keycloak.example.com/realms/main. Setting the OIDC group at all makes single sign-on the offered option.',
    ifWrong:
      'Boot fails if the group is half-configured — on purpose. A partially configured IdP fails at the callback instead, after the user has already authenticated, which is the worst moment to find out.',
  },
  {
    name: 'OIDC_CLIENT_ID',
    scope: 'api',
    required: false,
    purpose: 'Client id your IdP issued for RepoPulse.',
    ifWrong: 'The IdP rejects the authorization request before the user can approve anything.',
  },
  {
    name: 'OIDC_CLIENT_SECRET',
    scope: 'api',
    required: false,
    purpose: 'Client secret for the token exchange.',
    ifWrong: 'Sign-in fails at the code exchange, after the user has already approved.',
    secret: true,
  },
  {
    name: 'OIDC_REDIRECT_URI',
    scope: 'api',
    required: false,
    purpose: 'Callback URL registered with the IdP — <PUBLIC_BASE_URL>/auth/oidc/callback.',
    ifWrong: 'The IdP refuses to redirect back; most report this as an unregistered redirect URI.',
  },
  {
    name: 'OIDC_SCOPES',
    scope: 'api',
    required: false,
    purpose: 'Scopes requested at sign-in.',
    ifWrong: 'Dropping `openid` means no ID token comes back and sign-in cannot complete.',
    default: 'openid profile email',
  },
  {
    name: 'OIDC_DISPLAY_NAME',
    scope: 'api',
    required: false,
    purpose: 'Label on the sign-in button, so it can read "Log in with Acme SSO".',
    ifWrong: 'Only cosmetic — the button falls back to a generic label.',
    default: 'Single sign-on',
  },
  {
    name: 'FORGE_TOKEN',
    scope: 'api',
    required: false,
    purpose:
      'Read ONLY by the headless `pnpm connect:forge` bootstrap, never by the running server. Supply it on that one command line, not in a file.',
    ifWrong:
      'The bootstrap refuses to run without it and prints where to generate one. A wrong token is reported by name (bad_token / bad_scope / no_repos) before anything is stored, so a bad credential never reaches the database.',
    secret: true,
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
    name: 'HOST',
    scope: 'shared',
    required: false,
    purpose:
      'Interface the API and the worker /healthz server bind. Loopback by default so a host-run process is not on the LAN; the container images set 0.0.0.0 so the web proxy can reach the api over the compose network (only the web port is published, on REPOPULSE_BIND).',
    ifWrong:
      "0.0.0.0 on a host-run process exposes the API and the worker's /metrics to every network the machine is on. 127.0.0.1 inside a container makes the api unreachable from the web proxy (502).",
    default: '127.0.0.1',
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
    // Read by Node itself at process start, not by our code. Registered so the
    // setup screen and CONFIG.md name the supported way to trust an internal CA.
    name: 'NODE_EXTRA_CA_CERTS',
    scope: 'shared',
    required: false,
    purpose:
      "Path INSIDE the container to a PEM file of extra CA certificates, added to Node's built-in roots. Set it when a self-hosted Gitea, GitLab or GitHub Enterprise (or your OIDC issuer) uses a certificate from an internal CA. In the deploy stack, put the PEM in EXTRA_CA_DIR (default deploy/ca) and set this to /etc/repopulse/ca/<file>.pem.",
    ifWrong:
      'Unset with an internal-CA forge: connecting fails with a TLS error (unable to verify the first certificate / unable to get local issuer certificate). A path that does not exist or is unreadable is only a warning from Node at startup, and the extra CA is silently not trusted.',
    default: 'unset',
  },
  {
    name: 'SNAPSHOT_ROOT',
    scope: 'worker',
    required: false,
    purpose: 'Scratch directory for C1a scan snapshots. Cleared by the sweeper.',
    ifWrong:
      'Scans fail to extract; a non-ephemeral path retains customer source longer than intended.',
    default: 'the system temp directory',
  },
  {
    name: 'SCAN_RULES_DIR',
    scope: 'worker',
    required: false,
    purpose:
      'Host directory holding the scan rulepacks and the grype vulnerability database, mounted read-only into the --network=none scan container. Filled by deploy/scan-db-sync.sh on the host, on your schedule.',
    ifWrong:
      'Dependency scanning has no CVE data and fails rather than reporting a clean tree. MUST BE ABSOLUTE — a relative path is not resolved against the compose file and the worker will not start. Budget ~2 GB: the grype database alone is 1.9 GB, which is also why we fetch it here instead of shipping it.',
    default: '/var/lib/repopulse/scan-rules',
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
    name: 'SCAN_RUNNER_URL',
    scope: 'worker',
    required: false,
    purpose:
      'Where the worker reaches the scan-runner sidecar (W17-27), the one container that holds the runtime socket and launches the --network=none scan containers on its behalf. http://host:port; SCAN_RUNNER_SOCKET is the unix-socket alternative. The packaged stack sets it to the scan-runner service on the internal scan network.',
    ifWrong:
      'Every tool-based scan reports the sandbox as unavailable and no findings are persisted; the worker itself never touches the container runtime.',
    default: 'http://scan-runner:3310 in deploy/compose.yaml; unset means no runner',
  },
  {
    name: 'SCAN_RUNNER_TOKEN',
    scope: 'worker',
    required: false,
    purpose:
      'Shared secret between the worker and the scan-runner sidecar. Mandatory whenever the runner listens on TCP (the packaged stack); deploy/configure.mjs generates it and deploy/up.sh refuses to start without it.',
    ifWrong:
      'The runner refuses to start (TCP listener with no token) or answers 401 to every scan request, so scans fail as sandbox-unavailable with no findings.',
    secret: true,
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
    purpose:
      "Nightly W10 register pass (knowledge, supply chain, architecture, test gap). 'off' disables it.",
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
    name: 'LMSTUDIO_BASE_URLS',
    scope: 'worker',
    required: false,
    purpose:
      'DEPRECATED since W16-08 — configure models in Admin → Models instead, which needs no restart and supports hosted providers as well as LAN ones. Kept so an existing install does not lose its model on upgrade; a configured provider always wins over this. Comma-separated OpenAI-compatible endpoints for Tier-2 analysis (http://host:1234/v1). Absent means no Tier-2: the whole Tier-1 product still works.',
    ifWrong:
      'Scheduled judgement passes skip with reason no_gateway. Pointing at an unreachable host is worse than leaving it unset — the passes then FAIL rather than skip, which is deliberate: a host you configured and cannot reach is a fault, not a choice.',
  },
  {
    name: 'LMSTUDIO_MODEL',
    scope: 'worker',
    required: false,
    purpose:
      'DEPRECATED since W16-08 — see Admin → Models. The loaded model id to request. Use an INSTRUCT or CODER model, e.g. qwen3-coder-30b-a3b-instruct. Required whenever LMSTUDIO_BASE_URLS is set.',
    ifWrong:
      'LM Studio answers 400 "Invalid model identifier" on every call. There is no default because a guessed model name is a guess about your machine; with it unset the gateway refuses to build and says which variable is missing. A REASONING model is the subtler mistake: measured here, qwen3.5-9b spent an entire 4000-token budget on reasoning and returned no answer at all, and at the tier\'s 45000 cap that is twenty minutes per chunk before the request is abandoned. The scanner now reports that by name rather than as a clean result, but the fix is the model: an instruct model answered the same prompt in 12 seconds.',
  },
  {
    name: 'LMSTUDIO_CONCURRENCY',
    scope: 'worker',
    required: false,
    purpose: 'Per-host concurrent Tier-2 request cap (FR-ANALYSIS-8).',
    ifWrong:
      'Set too high, a local model thrashes and calls time out; the scheduler parks instead of queueing invisibly.',
    default: '1',
  },
  {
    name: 'LMSTUDIO_REQUEST_TIMEOUT_MS',
    scope: 'worker',
    required: false,
    purpose:
      'Wall-clock budget for ONE Tier-2 completion (W16-39). Raise it for a large reasoning model on a busy host.',
    ifWrong:
      'Too low and a legitimately slow generation is killed mid-answer, which reads as a scanner that found nothing. Too high and a stalled stream leaves the scan sitting at "running" until someone notices. Before this existed the bound was undici\'s 300s header timeout, which killed every checklist against a 27B model at exactly 301s.',
    default: '1200000 (20 minutes)',
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
