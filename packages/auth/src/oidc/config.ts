import { OidcError } from './errors.js';

// OIDC is configured entirely from the environment (D14, acceptance 5), and
// this file is deliberately a PURE function over a passed-in record rather
// than a reader of the ambient process environment: the API owns every
// environment read (see apps/api/src/index.ts and the env registry that
// documents them), and a library that reaches for globals cannot be tested
// without mutating the test runner's process.

export interface OidcConfig {
  /** The issuer identifier exactly as the IdP publishes it, e.g. https://id.example.com */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Must match the redirect_uri registered with the IdP, byte for byte. */
  redirectUri: string;
  /** Space-delimited; `openid` is always forced on because it is what makes this OIDC. */
  scopes: string;
  /** What the login page calls this button, since "OIDC" means nothing to an end user. */
  displayName: string;
}

export const OIDC_ENV_VARS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_SCOPES',
  'OIDC_DISPLAY_NAME',
] as const;

const REQUIRED = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'] as const;

const DEFAULT_SCOPES = 'openid profile email';
const DEFAULT_DISPLAY_NAME = 'Single sign-on';

/** An empty string is a half-filled `.env` line, which is absence, not a value. */
function read(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Returns the configuration, or `null` when this deployment does not offer OIDC.
 *
 * The three-way outcome matters. NOTHING set means the operator did not want
 * OIDC and the login page simply does not show it. SOME set means they tried
 * and got it wrong, and that has to be loud at startup — "issuer configured,
 * secret missing" presenting as a silently absent button is an hour of
 * someone's evening spent looking in the wrong place.
 */
export function oidcConfigFromEnv(env: Record<string, string | undefined>): OidcConfig | null {
  const present = REQUIRED.filter((name) => read(env, name) !== undefined);
  if (present.length === 0) return null;

  const missing = REQUIRED.filter((name) => read(env, name) === undefined);
  if (missing.length > 0) {
    throw new OidcError(
      'oidc_not_configured',
      `OIDC is partially configured: ${present.join(', ')} set but ${missing.join(', ')} missing. ` +
        'Set all of them to enable OIDC, or none of them to disable it.',
    );
  }

  const issuer = read(env, 'OIDC_ISSUER') as string;
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new OidcError('oidc_not_configured', `OIDC_ISSUER must be an absolute URL, got: ${issuer}`);
  }
  // http:// is allowed only so a fixture or a LAN test IdP works; anything an
  // operator points at in anger is https, and the discovery step will fail
  // loudly rather than silently downgrade.
  if (issuerUrl.protocol !== 'https:' && issuerUrl.protocol !== 'http:') {
    throw new OidcError('oidc_not_configured', 'OIDC_ISSUER must be an http(s) URL');
  }

  const scopes = read(env, 'OIDC_SCOPES') ?? DEFAULT_SCOPES;
  return {
    issuer,
    clientId: read(env, 'OIDC_CLIENT_ID') as string,
    clientSecret: read(env, 'OIDC_CLIENT_SECRET') as string,
    redirectUri: read(env, 'OIDC_REDIRECT_URI') as string,
    scopes: scopes.split(/\s+/).includes('openid') ? scopes : `openid ${scopes}`,
    displayName: read(env, 'OIDC_DISPLAY_NAME') ?? DEFAULT_DISPLAY_NAME,
  };
}
