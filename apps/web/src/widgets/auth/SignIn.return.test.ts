import { describe, expect, it } from 'vitest';
import { callbackErrorFrom, federatedHref } from './SignIn.js';

// W20-10 (UX_TODO X-01): a federated sign-in started from a shared link
// returns to it, instead of always landing on Overview.
const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('federatedHref', () => {
  it('passes the page it was opened on as return_to', () => {
    expect(federatedHref('/auth/oidc/login', at('/findings', '?finding=812'))).toBe(
      `/auth/oidc/login?return_to=${encodeURIComponent('/findings?finding=812')}`,
    );
  });

  it('drops the sign-in error it was showing, so a retry does not return to it', () => {
    expect(
      federatedHref('/auth/login', at('/repos/4', '?auth_error=not_allowed&request_id=r1&tab=x')),
    ).toBe(`/auth/login?return_to=${encodeURIComponent('/repos/4?tab=x')}`);
  });

  it('adds nothing from the root', () => {
    expect(federatedHref('/auth/login', at('/', '?auth_error=x'))).toBe('/auth/login');
  });
});

describe('callback errors (INS-50)', () => {
  it('explains a refusal by the allowlist, and an org check that failed', () => {
    expect(callbackErrorFrom('?auth_error=not_allowed')?.message).toMatch(/allow/i);
    expect(callbackErrorFrom('?auth_error=org_check_failed')?.message).not.toBe(
      'Sign-in did not complete. Please try again.',
    );
  });
});
