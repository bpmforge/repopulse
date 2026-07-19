import { createAppAuth } from '@octokit/auth-app';

// GitHub auth (FORGE_PROVIDER §4). Two modes: App (primary, short-lived
// installation tokens) and PAT (dev fallback). Produces the Authorization
// header the executor attaches to every forge call.

export type GitHubAuth =
  | { kind: 'pat'; token: string }
  | {
      kind: 'app';
      appId: string | number;
      privateKey: string;
      installationId: string | number;
    };

export interface AuthHeaderProvider {
  /** Authorization header(s) for the next request (mints/refreshes as needed). */
  headers(): Promise<Record<string, string>>;
  /** Drop any cached token so the next headers() re-mints (wired to a 401). */
  invalidate(): void;
}

export interface InstallationToken {
  token: string;
  /** Absolute expiry (epoch ms). */
  expiresAtMs: number;
}

// A PAT is static — no lifecycle. GitHub accepts Bearer for PAT + App tokens.
function patHeaderProvider(token: string): AuthHeaderProvider {
  const headers = { authorization: `Bearer ${token}` };
  return {
    headers: () => Promise.resolve(headers),
    invalidate: () => {},
  };
}

export interface AppHeaderProviderOptions {
  /** Mints a fresh installation token (JWT → POST access_tokens). Injected so
   * the refresh lifecycle is testable without real crypto/network. */
  mintInstallationToken: () => Promise<InstallationToken>;
  now?: () => number;
  /** Re-mint this many ms BEFORE expiry — 10min of a 60min token ⇒ refresh at
   * ~50min (FORGE_PROVIDER §4 / research §8). */
  refreshSkewMs?: number;
}

const DEFAULT_REFRESH_SKEW_MS = 10 * 60 * 1000;

// Caches one installation token and proactively re-mints it before expiry.
export function createAppHeaderProvider(opts: AppHeaderProviderOptions): AuthHeaderProvider {
  const now = opts.now ?? (() => Date.now());
  const skew = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  let cached: InstallationToken | null = null;
  let inFlight: Promise<InstallationToken> | null = null;

  async function current(): Promise<InstallationToken> {
    if (cached && now() < cached.expiresAtMs - skew) return cached;
    // Coalesce concurrent mints so a burst of parked-then-released lanes does
    // not trigger N token exchanges.
    if (!inFlight) {
      inFlight = opts
        .mintInstallationToken()
        .then((t) => {
          cached = t;
          return t;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    async headers() {
      const { token } = await current();
      return { authorization: `Bearer ${token}` };
    },
    invalidate() {
      cached = null;
    },
  };
}

// Real minter: @octokit/auth-app does the JWT (≤10min) → installation-token
// (1h) exchange; we adapt its result to our InstallationToken shape.
export function githubAppInstallationMinter(auth: {
  appId: string | number;
  privateKey: string;
  installationId: string | number;
}): () => Promise<InstallationToken> {
  const authenticate = createAppAuth({
    appId: auth.appId,
    privateKey: auth.privateKey,
    installationId: auth.installationId,
  });
  return async () => {
    const result = await authenticate({ type: 'installation' });
    return { token: result.token, expiresAtMs: Date.parse(result.expiresAt) };
  };
}

export function createAuthHeaderProvider(
  auth: GitHubAuth,
  opts: Omit<AppHeaderProviderOptions, 'mintInstallationToken'> = {},
): AuthHeaderProvider {
  if (auth.kind === 'pat') return patHeaderProvider(auth.token);
  return createAppHeaderProvider({
    mintInstallationToken: githubAppInstallationMinter(auth),
    ...opts,
  });
}
