// Who may join through single sign-on (W20-10, UX_TODO INS-50).
//
// Anyone the identity provider accepted, and anyone with any GitHub account at
// all, became a workspace member on their first sign-in. On a GitHub-enabled
// install that is the whole internet. This is the allowlist: GitHub orgs for
// "Sign in with GitHub", OIDC groups and email domains for OIDC.
//
// Checked on EVERY federated sign-in, not only the first, so someone who left
// the org or the IdP group stops getting in — which is also the honest answer
// to "Remove does not keep them out": with an allowlist set, removing them
// from the org/group is what ends their access.
//
// Unset means open, exactly as before, so an existing install is not locked
// out by an upgrade. Local accounts never pass through here: an admin made them.
//
// A PURE function over a passed-in record, like oidcConfigFromEnv: the API owns
// the environment read (apps/api/src/index.ts, documented in the env registry).

export interface AdmissionPolicy {
  /** Lower-cased GitHub org logins; empty = any GitHub account. */
  githubOrgs: string[];
  /** OIDC `groups` claim values (exact match); empty = not checked. */
  oidcGroups: string[];
  /** Lower-cased email domains for OIDC; empty = not checked. */
  emailDomains: string[];
}

export const ADMISSION_ENV_VARS = [
  'SSO_ALLOWED_GITHUB_ORGS',
  'SSO_ALLOWED_OIDC_GROUPS',
  'SSO_ALLOWED_EMAIL_DOMAINS',
] as const;

function list(value: string | undefined, lower: boolean): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (lower ? v.toLowerCase().replace(/^@/, '') : v));
}

export function admissionPolicyFromEnv(env: Record<string, string | undefined>): AdmissionPolicy {
  return {
    githubOrgs: list(env.SSO_ALLOWED_GITHUB_ORGS, true),
    oidcGroups: list(env.SSO_ALLOWED_OIDC_GROUPS, false),
    emailDomains: list(env.SSO_ALLOWED_EMAIL_DOMAINS, true),
  };
}

export type AdmissionResult =
  { ok: true } | { ok: false; reason: 'not_in_allowed_org' | 'not_in_allowed_group_or_domain' };

/** GitHub: a member of at least one allowed org, when any are configured. */
export function admitGithub(
  policy: AdmissionPolicy,
  orgLogins: readonly string[],
): AdmissionResult {
  if (policy.githubOrgs.length === 0) return { ok: true };
  const mine = new Set(orgLogins.map((o) => o.toLowerCase()));
  return policy.githubOrgs.some((o) => mine.has(o))
    ? { ok: true }
    : { ok: false, reason: 'not_in_allowed_org' };
}

export interface OidcAdmissionFacts {
  email?: string | undefined;
  /** False only when the IdP SAID the address is unverified; absent is trusted. */
  emailVerified?: boolean | undefined;
  /** The ID token's `groups` claim, when the IdP sends one. */
  groups?: unknown;
}

/**
 * OIDC: when groups and/or domains are configured, matching EITHER admits. An
 * email the IdP itself marks unverified never matches a domain — anyone can
 * type an address at most IdPs' self-service signup.
 */
export function admitOidc(policy: AdmissionPolicy, facts: OidcAdmissionFacts): AdmissionResult {
  if (policy.oidcGroups.length === 0 && policy.emailDomains.length === 0) return { ok: true };
  const groups = Array.isArray(facts.groups)
    ? facts.groups.filter((g): g is string => typeof g === 'string')
    : [];
  if (policy.oidcGroups.some((g) => groups.includes(g))) return { ok: true };
  const domain = facts.email?.split('@').pop()?.toLowerCase();
  if (
    domain !== undefined &&
    facts.email?.includes('@') &&
    facts.emailVerified !== false &&
    policy.emailDomains.includes(domain)
  ) {
    return { ok: true };
  }
  return { ok: false, reason: 'not_in_allowed_group_or_domain' };
}

/** True when any GitHub allowlist is set, so the sign-in must fetch org membership. */
export function needsGithubOrgs(policy: AdmissionPolicy): boolean {
  return policy.githubOrgs.length > 0;
}
