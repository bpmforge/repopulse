import { describe, expect, it } from 'vitest';
import { admissionPolicyFromEnv, admitGithub, admitOidc, needsGithubOrgs } from './index.js';

// W20-10 (UX_TODO INS-50): who may join through single sign-on.
describe('admission', () => {
  const open = admissionPolicyFromEnv({});

  it('is open when nothing is configured (an upgrade locks nobody out)', () => {
    expect(admitGithub(open, [])).toEqual({ ok: true });
    expect(admitOidc(open, {})).toEqual({ ok: true });
    expect(needsGithubOrgs(open)).toBe(false);
  });

  it('parses lists, lower-casing orgs and domains', () => {
    const p = admissionPolicyFromEnv({
      SSO_ALLOWED_GITHUB_ORGS: ' Acme , ,Widgets',
      SSO_ALLOWED_OIDC_GROUPS: 'Eng,ops',
      SSO_ALLOWED_EMAIL_DOMAINS: '@Acme.com',
    });
    expect(p).toEqual({
      githubOrgs: ['acme', 'widgets'],
      oidcGroups: ['Eng', 'ops'],
      emailDomains: ['acme.com'],
    });
    expect(needsGithubOrgs(p)).toBe(true);
  });

  it('admits a GitHub member of an allowed org, case-insensitively', () => {
    const p = admissionPolicyFromEnv({ SSO_ALLOWED_GITHUB_ORGS: 'acme' });
    expect(admitGithub(p, ['other', 'ACME'])).toEqual({ ok: true });
    expect(admitGithub(p, ['other'])).toEqual({ ok: false, reason: 'not_in_allowed_org' });
  });

  it('admits OIDC by group or by a verified domain', () => {
    const p = admissionPolicyFromEnv({
      SSO_ALLOWED_OIDC_GROUPS: 'eng',
      SSO_ALLOWED_EMAIL_DOMAINS: 'acme.com',
    });
    expect(admitOidc(p, { groups: ['eng'] }).ok).toBe(true);
    expect(admitOidc(p, { email: 'a@ACME.com' }).ok).toBe(true);
    expect(admitOidc(p, { email: 'a@acme.com', emailVerified: true }).ok).toBe(true);
    expect(admitOidc(p, { email: 'a@acme.com', emailVerified: false })).toEqual({
      ok: false,
      reason: 'not_in_allowed_group_or_domain',
    });
    expect(admitOidc(p, { email: 'a@evil.com', groups: ['Eng', 7] }).ok).toBe(false);
    expect(admitOidc(p, { email: 'acme.com' }).ok).toBe(false);
  });
});
