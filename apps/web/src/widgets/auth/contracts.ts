import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.js';

// The auth surface the browser talks to (W15-04, D14).
//
// EVERYTHING HERE BYPASSES useApiQuery/useApiMutation ON PURPOSE. `buildUrl`
// prefixes anything that does not already start with /api/v1, so
// `useApiQuery({endpoint: '/auth/providers'})` would request
// /api/v1/auth/providers, which does not exist — the same trap documented in
// apps/api/src/routes/me/index.ts. `apiFetch` takes a URL verbatim and already
// carries the session cookie, the CSRF header and the problem-envelope parsing,
// and the dev server proxies /auth alongside /api.
//
// Staying off useApiQuery has a second benefit that is not incidental: its
// session-expiry watcher treats any 401 as "the session ended". A wrong
// password is a 401, and routing it through that hook would make a failed
// sign-in attempt invalidate the session query on every keystroke's worth of
// retry.

export interface AuthProviders {
  /** Always true — local accounts are what make this installable (D14). */
  local: boolean;
  /** null when this deployment did not configure OIDC. */
  oidc: { display_name: string } | null;
  /** True only when a GitHub App is configured, i.e. /auth/login exists. */
  github: boolean;
  /**
   * Non-null only in demo mode (W16-02). The sign-in screen cannot ask
   * /me/context whether this is a demo — there is no session yet — so this is
   * how the one screen that most needs the demo banner gets it.
   */
  demo?: { email: string; password: string } | null;
  /**
   * W20-07 (UX_TODO INS-01). True when the session cookie is `Secure`, which a
   * browser drops on plain http anywhere but localhost. Optional: older API.
   */
  secure_cookies?: boolean;
}

export const AUTH_PROVIDERS_KEY = ['auth', 'providers'] as const;
export const LOCAL_SESSION_KEY = ['auth', 'local-session'] as const;

/**
 * What we believe when the API cannot tell us.
 *
 * NOT "show every button": a button for a provider nobody configured is the
 * exact defect this endpoint exists to prevent, and it fails at the vendor's
 * door where the person cannot tell whose fault it is. Local sign-in is the one
 * thing every deployment has, so an unreachable discovery endpoint degrades to
 * the password form and nothing else.
 */
export const LOCAL_ONLY: AuthProviders = { local: true, oidc: null, github: false, demo: null };

export function useAuthProviders(): { providers: AuthProviders; ready: boolean } {
  const { data, isPending } = useQuery<AuthProviders>({
    queryKey: AUTH_PROVIDERS_KEY,
    queryFn: () => apiFetch<AuthProviders>('/auth/providers'),
    // A deployment's provider list does not change while someone is looking at
    // the sign-in screen, and a retry loop behind a login form is noise.
    staleTime: Infinity,
    retry: false,
  });
  return { providers: data ?? LOCAL_ONLY, ready: !isPending };
}

/**
 * Whether this browser holds a session that is pending a forced password change.
 *
 * Such a session carries no `userId`, so /me/context 401s and the shell's
 * `useSession` reports 'anonymous' — indistinguishable, without this, from
 * never having signed in. A reload mid-change would otherwise strand a
 * bootstrap admin on a sign-in form that rejects the password they were given.
 */
export function usePendingPasswordChange(enabled: boolean): {
  pending: boolean;
  ready: boolean;
} {
  const { data, isPending } = useQuery<{ pending_password_change: boolean }>({
    queryKey: LOCAL_SESSION_KEY,
    queryFn: () => apiFetch<{ pending_password_change: boolean }>('/auth/local/session'),
    enabled,
    retry: false,
  });
  return { pending: data?.pending_password_change === true, ready: !isPending };
}

export interface LocalLoginResult {
  must_change_password: boolean;
}

export function localLogin(email: string, password: string): Promise<LocalLoginResult> {
  return apiFetch<LocalLoginResult>('/auth/local/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function changePassword(current: string, next: string): Promise<unknown> {
  return apiFetch<unknown>('/auth/local/password', {
    method: 'POST',
    body: JSON.stringify({ current_password: current, new_password: next }),
  });
}

/**
 * Ends a real session (W20-01, UX_TODO ADM-02). The caller reloads the page
 * afterwards so the shell re-decides from scratch and lands on sign-in, with
 * no cached data from the old session left in memory.
 */
export function signOut(): Promise<unknown> {
  return apiFetch<unknown>('/auth/logout', { method: 'POST' });
}

/** Signs out, then reloads whether or not the request succeeded. */
export function signOutAndReload(
  go: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  return signOut()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => go('/'));
}

/**
 * "Sign out everywhere" (W20-10, UX_TODO ADM-78): ends every session this
 * account holds — a laptop left signed in at a client, a lost phone — this one
 * included, then reloads onto the sign-in screen.
 */
export function signOutEverywhereAndReload(
  go: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  // No reload on failure: the caller shows why, and this session is still live.
  return apiFetch<unknown>('/auth/sessions/revoke-all', { method: 'POST' }).then(() => go('/'));
}

/** Walks away from a session that cannot do anything else (see local.ts). */
export function abandonPendingSession(): Promise<unknown> {
  return apiFetch<unknown>('/auth/local/logout', { method: 'POST' });
}

/** Why a personalized view is empty — see GET /auth/identity. */
export interface IdentityLink {
  state: 'linked' | 'unlinked' | 'no_activity';
  identity_id: number | null;
}

export function useIdentityLink(): { link: IdentityLink | undefined } {
  const { data } = useQuery<IdentityLink>({
    queryKey: ['auth', 'identity'],
    queryFn: () => apiFetch<IdentityLink>('/auth/identity'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { link: data };
}

export interface CreatedUser {
  user: { id: number; login: string; email: string | null };
  /** Present ONLY when the API generated it, and never retrievable again. */
  temporary_password?: string;
  /** The role they start with (W20-19, UX_TODO INS-62); absent from an older API. */
  role?: 'admin' | 'member';
  /** PUBLIC_BASE_URL + '/', where they sign in (INS-62). */
  sign_in_url?: string;
}

export function createLocalUser(body: {
  email: string;
  name?: string;
  password?: string;
  role?: 'admin' | 'member';
}): Promise<CreatedUser> {
  return apiFetch<CreatedUser>('/auth/local/users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
