import { describe, expect, it } from 'vitest';
import { OidcError } from './errors.js';
import { oidcConfigFromEnv } from './config.js';

const complete = {
  OIDC_ISSUER: 'https://id.example.test',
  OIDC_CLIENT_ID: 'repopulse',
  OIDC_CLIENT_SECRET: 'shhh',
  OIDC_REDIRECT_URI: 'https://repopulse.example.test/auth/oidc/callback',
};

describe('reading OIDC configuration from the environment', () => {
  it('returns null when the deployment did not configure OIDC — the button simply is not offered', () => {
    expect(oidcConfigFromEnv({})).toBeNull();
  });

  it('fails loudly on a HALF-configured deployment instead of silently hiding the button', () => {
    // Silence here is an hour of someone's evening: the operator set the
    // issuer, sees no SSO option, and goes looking in the wrong place.
    const error = (() => {
      try {
        oidcConfigFromEnv({ OIDC_ISSUER: 'https://id.example.test' });
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(OidcError);
    expect((error as OidcError).message).toContain('OIDC_CLIENT_ID');
    expect((error as OidcError).message).toContain('OIDC_CLIENT_SECRET');
  });

  it('treats an empty value as absent, because `OIDC_ISSUER=` is a half-filled .env line', () => {
    expect(oidcConfigFromEnv({ OIDC_ISSUER: '   ' })).toBeNull();
  });

  it('defaults the scopes and the button label', () => {
    const config = oidcConfigFromEnv(complete);
    expect(config?.scopes).toBe('openid profile email');
    expect(config?.displayName).toBe('Single sign-on');
  });

  it('forces the openid scope on, since without it the provider need not return an ID token', () => {
    const config = oidcConfigFromEnv({ ...complete, OIDC_SCOPES: 'profile groups' });
    expect(config?.scopes).toBe('openid profile groups');
  });

  it('does not duplicate openid when the operator already listed it', () => {
    const config = oidcConfigFromEnv({ ...complete, OIDC_SCOPES: 'openid email' });
    expect(config?.scopes).toBe('openid email');
  });

  it('rejects an issuer that is not an absolute URL', () => {
    expect(() => oidcConfigFromEnv({ ...complete, OIDC_ISSUER: 'id.example.test' })).toThrow(
      OidcError,
    );
  });
});
