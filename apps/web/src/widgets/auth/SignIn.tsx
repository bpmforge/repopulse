import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SESSION_ENDPOINT, queryKeyFor } from '../../api/useApiQuery.js';
import { errorMessageOf, requestIdOf } from '../../api/client.js';
import {
  LOCAL_SESSION_KEY,
  localLogin,
  useAuthProviders,
  type LocalLoginResult,
} from './contracts.js';
import { RepoPulseMark } from '../../components/brand/RepoPulseMark.js';

// The sign-in screen (W15-04, D14).
//
// It renders EXACTLY the providers this deployment configured, because since
// D14 an install offers some subset of three: local accounts always, OIDC when
// the environment set it up, GitHub when an App exists. The screen this
// replaced offered one hardcoded "Sign in with GitHub" link, which on a
// self-hosted install with no GitHub App is a button whose only outcome is a
// 404 — and, worse, one that made a Gitea customer believe they needed a
// GitHub account to use the product.
//
// The two federated options are ANCHORS, not buttons: /auth/oidc/login and
// /auth/login are full-page redirects that end at a provider and come back with
// a cookie, so they must leave the SPA entirely. Local sign-in is the opposite —
// it is a form whose answer is JSON, after which the shell's session query is
// invalidated and the app mounts in place.

/**
 * Why a federated sign-in came back without a session (W20-04, UX_TODO INS-14).
 *
 * The OIDC and GitHub callbacks are full-page navigations; when one failed it
 * used to end on a raw JSON problem body. The API now redirects here with one
 * of its own reason codes and the request id, and this is the sentence for
 * each — what happened, in words, and what to try.
 */
const CALLBACK_ERRORS: Record<string, string> = {
  missing_code_or_state:
    'That sign-in could not be completed — it took too long, or was started in another tab. Please try again.',
  missing_state_cookie:
    'That sign-in could not be completed — it took too long, or was started in another tab. Please try again.',
  state_mismatch:
    'That sign-in could not be completed — it took too long, or was started in another tab. Please try again.',
  oidc_provider_error:
    'Your identity provider refused the sign-in. If you expected it to work, ask your administrator to check your access.',
  oidc_discovery_failed:
    'RepoPulse could not reach your identity provider. Try again; if it keeps happening, tell your administrator.',
  oidc_exchange_failed:
    'RepoPulse could not finish signing you in with your identity provider. Try again; if it keeps happening, tell your administrator.',
  oauth_exchange_failed:
    'RepoPulse could not finish signing you in with GitHub. Try again; if it keeps happening, tell your administrator.',
  identity_fetch_failed:
    'GitHub did not say who you are, so you were not signed in. Try again; if it keeps happening, tell your administrator.',
  oidc_id_token_invalid:
    'Your identity provider’s answer could not be verified, so you were not signed in. Tell your administrator.',
  // W20-10 (UX_TODO INS-50): the SSO allowlist refused this account.
  not_allowed:
    'Your account is not on this install’s sign-in list (an allowed organization, group or email domain). If you should have access, ask your RepoPulse administrator.',
  org_check_failed:
    'RepoPulse could not check your GitHub organizations, so you were not signed in. Try again; if it keeps happening, tell your administrator.',
};

/**
 * Where a federated sign-in should come back to (W20-10, UX_TODO X-01).
 *
 * A colleague who opened a shared link signed out and then signed in with SSO
 * always landed on Overview: the provider round trip left the SPA and the API
 * returned to `/`. The page this screen is showing over IS the deep link, so it
 * goes to the login route as `return_to`; the API only follows a same-origin
 * path (and tests that guard). Overview needs no parameter, and this screen's
 * own error parameters are not part of where the person was going.
 */
export function federatedHref(
  base: string,
  location: { pathname: string; search: string; hash: string },
): string {
  const params = new URLSearchParams(location.search);
  params.delete('auth_error');
  params.delete('request_id');
  const query = params.toString();
  const path = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  if (path === '/' || !path.startsWith('/') || path.startsWith('//')) return base;
  return `${base}?return_to=${encodeURIComponent(path)}`;
}

export interface CallbackError {
  message: string;
  requestId: string | null;
}

/** Reads `?auth_error=&request_id=` (exported for its test). */
export function callbackErrorFrom(search: string): CallbackError | null {
  const params = new URLSearchParams(search);
  const code = params.get('auth_error');
  if (!code) return null;
  return {
    // Unknown codes still say SOMETHING true, rather than nothing.
    message: CALLBACK_ERRORS[code] ?? 'Sign-in did not complete. Please try again.',
    requestId: params.get('request_id'),
  };
}

/** Read once, then drop the params so a reload does not repeat a stale error. */
function useCallbackError(): CallbackError | null {
  const [error] = useState(() =>
    typeof window === 'undefined' ? null : callbackErrorFrom(window.location.search),
  );
  useEffect(() => {
    if (!error || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('auth_error');
    url.searchParams.delete('request_id');
    // history.state is kept: the router keys its entries on it.
    window.history.replaceState(window.history.state, '', url.toString());
  }, [error]);
  return error;
}

/**
 * Why signing in here cannot stick (W20-07, UX_TODO INS-01), or null.
 *
 * An install writes NODE_ENV=production, so the session cookie is `Secure`,
 * and a browser silently drops a Secure cookie on a plain-http page anywhere
 * but localhost. A LAN trial at http://192.168.x.y:8099 therefore signed in
 * "successfully" and landed straight back here with no error, forever. This is
 * the SAFE fix: say so before the attempt. There is deliberately no switch to
 * send the session cookie over plain http — that would put every session on
 * the LAN in clear text.
 *
 * `isSecureContext` is the browser's own answer (https, or localhost), so no
 * hostname list can drift from it.
 */
export function insecureSessionWarning(
  secureCookies: boolean | undefined,
  isSecureContext: boolean | undefined,
): string | null {
  if (!secureCookies || isSecureContext !== false) return null;
  return 'Signing in will not stick on this address. This install only keeps sessions over HTTPS (or on localhost), and this page was opened over plain http — your browser drops the session, so you would land back here. Open RepoPulse through HTTPS, or on the server itself at http://localhost. See Installing → Troubleshooting.';
}

export interface SignInProps {
  /** True when this browser HAD a session — a different sentence, same screen. */
  expired: boolean;
}

export function SignIn({ expired }: SignInProps) {
  const queryClient = useQueryClient();
  const { providers, ready } = useAuthProviders();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const callbackError = useCallbackError();
  const insecure = insecureSessionWarning(
    providers.secure_cookies,
    typeof window === 'undefined' ? undefined : window.isSecureContext,
  );

  // Prefill the demo credentials once the providers response arrives, and only
  // while the visitor has not typed: filling a field someone is editing is a
  // worse bug than the empty form. Demo mode is disposable by definition, so
  // there is nothing here worth making a person retype from a banner.
  const demoEmail = providers.demo?.email;
  const demoPassword = providers.demo?.password;
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || demoEmail === undefined || demoPassword === undefined) return;
    prefilled.current = true;
    setEmail((current) => (current === '' ? demoEmail : current));
    setPassword((current) => (current === '' ? demoPassword : current));
  }, [demoEmail, demoPassword]);

  const login = useMutation<LocalLoginResult, Error, { email: string; password: string }>({
    mutationFn: (vars) => localLogin(vars.email, vars.password),
    onSuccess: async (result) => {
      // Both outcomes are handled by asking the shell to re-decide rather than
      // by navigating: a normal login now has a session, and a forced change
      // has a session the shell reads through /auth/local/session. Neither
      // screen decides what comes next — RootShell does, in one place.
      await queryClient.invalidateQueries({ queryKey: LOCAL_SESSION_KEY });
      if (!result.must_change_password) {
        await queryClient.invalidateQueries({
          queryKey: queryKeyFor({ endpoint: SESSION_ENDPOINT }),
        });
      }
    },
    onError: () => {
      // Move focus to the message. Without this a keyboard or screen-reader
      // user submits, hears nothing, and has no idea the form refused them —
      // the live region announces it, but the caret is still in a field whose
      // contents are now wrong.
      requestAnimationFrame(() => errorRef.current?.focus());
    },
  });

  return (
    // w-full, not w-screen (W20-17, UX_TODO INS-46): 100vw adds a sideways
    // scrollbar on desktops with classic scrollbars.
    <div className="flex min-h-screen w-full items-center justify-center bg-bg bg-[radial-gradient(70%_45%_at_50%_0%,var(--glow),transparent)] p-6 text-fg">
      <main className="panel panel-hero w-full max-w-sm p-7" data-testid="signin">
        {/* W16-02 (F2). The demo banner is in the shell, which only mounts
            AFTER sign-in — so the one screen where a visitor needs to be told
            "this is fake, and here is how to get in" was the one screen that
            said nothing. It also has to carry the credentials: demo mode used
            to promise that any login worked, and it never did for this form. */}
        {providers.demo ? (
          <p
            className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
            data-testid="signin-demo-banner"
          >
            <span className="font-medium">Demo mode</span> — fake forge, seeded fixture data.
            Nothing here describes a real organization. Sign in with{' '}
            <code className="font-mono">{providers.demo.email}</code> /{' '}
            <code className="font-mono">{providers.demo.password}</code>, already filled in below.
          </p>
        ) : null}

        {/* W17-13: mark + wordmark. The mark is aria-hidden inside the
            wordmark, so the h1 still announces "RepoPulse" exactly once. */}
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <RepoPulseMark size={28} />
          RepoPulse
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          {expired
            ? // W20-04 (UX_TODO X-02): this screen now opens OVER the app, which
              // stays mounted, so what was typed is still there — but the write
              // that hit the expired session was refused and is not retried.
              'Your session ended. Sign in again to carry on — the page behind this stays as you left it, but the last change you made was not saved; make it again.'
            : 'Sign in to see your organization’s delivery, code health, and risk.'}
        </p>

        {insecure ? (
          <p
            role="alert"
            data-testid="signin-insecure-origin"
            className="mt-4 rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg"
          >
            {insecure}
          </p>
        ) : null}

        {callbackError && !login.error ? (
          <p
            role="alert"
            data-testid="signin-callback-error"
            className="mt-4 rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-fg"
          >
            {callbackError.message}
            {callbackError.requestId ? (
              <span
                className="ml-1 font-mono text-xs text-fg-faint"
                data-testid="signin-callback-request-id"
              >
                (request {callbackError.requestId})
              </span>
            ) : null}
          </p>
        ) : null}

        {/* One live region for the whole screen. Rendered always, empty when
            there is nothing to say: a region inserted at the moment of the
            error is frequently not announced at all. */}
        <p
          id={errorId}
          ref={errorRef}
          tabIndex={-1}
          aria-live="assertive"
          aria-atomic="true"
          data-testid="signin-error"
          className={
            login.error
              ? 'mt-4 rounded-sm border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-fg'
              : 'sr-only'
          }
        >
          {/* W16-18: the request id belongs here more than anywhere. A person
              who cannot sign in cannot reach any other screen to report from,
              and "invalid email or password" is deliberately identical for
              every cause — so the id is the ONLY thing that distinguishes a
              wrong password from a broken database in a support conversation. */}
          {login.error ? (
            <>
              {errorMessageOf(login.error) ?? 'Sign-in failed.'}
              {requestIdOf(login.error) ? (
                <span
                  className="ml-1 font-mono text-xs text-fg-faint"
                  data-testid="signin-request-id"
                >
                  (request {requestIdOf(login.error)})
                </span>
              ) : null}
            </>
          ) : (
            ''
          )}
        </p>

        {!ready ? (
          <p className="mt-5 text-sm text-fg-muted" data-testid="signin-loading">
            Loading sign-in options…
          </p>
        ) : (
          <>
            {providers.local ? (
              <form
                className="mt-5 flex flex-col gap-3"
                data-testid="signin-local"
                onSubmit={(event) => {
                  event.preventDefault();
                  login.mutate({ email, password });
                }}
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor={emailId} className="text-xs text-fg-muted">
                    Email
                  </label>
                  <input
                    id={emailId}
                    data-testid="signin-email"
                    type="email"
                    name="email"
                    autoComplete="username"
                    // W20-17 (UX_TODO INS-46): typing starts on arrival.
                    autoFocus
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-describedby={login.error ? errorId : undefined}
                    className="h-10 rounded-md border border-border bg-bg px-3 text-sm text-fg hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={passwordId} className="text-xs text-fg-muted">
                    Password
                  </label>
                  <input
                    id={passwordId}
                    data-testid="signin-password"
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-describedby={login.error ? errorId : undefined}
                    className="h-10 rounded-md border border-border bg-bg px-3 text-sm text-fg hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </div>
                <button
                  type="submit"
                  data-testid="signin-submit"
                  disabled={login.isPending}
                  className="inline-flex h-10 w-full items-center justify-center rounded-md bg-accent-strong px-3 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {login.isPending ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            ) : null}

            {providers.oidc || providers.github ? (
              <p className="mt-5 text-xs text-fg-faint" data-testid="signin-federated-label">
                Or continue with
              </p>
            ) : null}

            {providers.oidc ? (
              <a
                href={federatedHref('/auth/oidc/login', window.location)}
                data-testid="signin-oidc"
                className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-sm font-medium text-fg hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {/* The operator's own name for it. "Sign in with OIDC" means
                    nothing to the person who only knows it as "Okta". */}
                {providers.oidc.display_name}
              </a>
            ) : null}

            {providers.github ? (
              <a
                href={federatedHref('/auth/login', window.location)}
                data-testid="signin-github"
                className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-sm font-medium text-fg hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Sign in with GitHub
              </a>
            ) : null}

            <p className="mt-4 text-xs text-fg-faint">
              {/* No "create an account" link, and there must never be one: a
                  self-hosted install is usually reachable the day it comes up,
                  and open registration hands it to whoever finds the URL.
                  Accounts come from first boot or from an admin (D14). */}
              {providers.demo
                ? 'In a real install, accounts are created by your RepoPulse administrator.'
                : // W20-07 (UX_TODO INS-03): the way back from a forgotten
                  // password now exists, so the screen names it.
                  'Accounts are created by your RepoPulse administrator. Forgot your password? Ask them to reset it in Settings → Members.'}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
