import { describe, expect, it } from 'vitest';
import { authProvidersCheck } from './index.js';

// The sign-in row of the setup checklist (W15-05, D14).
//
// This exists because the checklist used to be read as a list of things you
// must do BEFORE you can use RepoPulse, and a forge connection was on it. An
// operator who reads "forge connection: missing" as "I cannot log in" goes and
// registers a GitHub App they did not need — which is the exact friction D14
// removed. These tests pin the words that prevent that reading.

describe('the sign-in row tells an operator which doors are actually live', () => {
  it('reports local accounts on an install with no forge App and no IdP', () => {
    const check = authProvidersCheck({});

    expect(check.status).toBe('ok');
    expect(check.detail).toContain('local password accounts');
    // The load-bearing sentence: without it the row is a list, and a list with
    // one entry does not answer the question the operator is actually asking.
    expect(check.detail).toContain('No forge App is configured, and none is needed to sign in');
  });

  it('never presents a missing forge App as something to fix', () => {
    // `missing` renders as "not done" on the checklist and feeds `ready`.
    // Sign-in on a bare install is done, so neither is true of it.
    expect(authProvidersCheck({}).status).not.toBe('missing');
  });

  it('lists GitHub sign-in only when a client id AND secret are both present', () => {
    const half = authProvidersCheck({ GITHUB_APP_CLIENT_ID: 'Iv1.abc' });
    expect(half.detail).not.toContain('GitHub sign-in');

    const whole = authProvidersCheck({
      GITHUB_APP_CLIENT_ID: 'Iv1.abc',
      GITHUB_APP_CLIENT_SECRET: 'secret',
    });
    expect(whole.detail).toContain('GitHub sign-in');
    expect(whole.detail).toContain('A forge App is not required to sign in');
  });

  it('names the IdP the way the sign-in button will, so the two can be compared', () => {
    const check = authProvidersCheck({
      OIDC_ISSUER: 'https://idp.example.com/realms/main',
      OIDC_CLIENT_ID: 'repopulse',
      OIDC_CLIENT_SECRET: 'shh',
      OIDC_REDIRECT_URI: 'https://repopulse.example.com/auth/oidc/callback',
      OIDC_DISPLAY_NAME: 'Acme SSO',
    });

    expect(check.detail).toContain('OIDC (Acme SSO)');
  });

  it('discloses no value, only which doors exist', () => {
    const check = authProvidersCheck({
      GITHUB_APP_CLIENT_ID: 'Iv1.abc',
      GITHUB_APP_CLIENT_SECRET: 'super-secret-value',
      OIDC_ISSUER: 'https://idp.example.com/realms/main',
      OIDC_CLIENT_ID: 'repopulse-client-id',
      OIDC_CLIENT_SECRET: 'another-secret',
      OIDC_REDIRECT_URI: 'https://repopulse.example.com/auth/oidc/callback',
    });

    const serialized = JSON.stringify(check);
    for (const secret of [
      'super-secret-value',
      'another-secret',
      'Iv1.abc',
      'repopulse-client-id',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
