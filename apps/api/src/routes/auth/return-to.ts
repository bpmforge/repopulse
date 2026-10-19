// Where a federated sign-in lands afterwards (W20-10, UX_TODO X-01).
//
// A signed-out colleague who opened a shared link (/findings?finding=812) and
// signed in with OIDC or GitHub always landed on Overview: the callback
// redirected to a fixed `/`, and the shared link was lost. The sign-in screen
// now passes the page it was opened on as `return_to`; the login route keeps it
// in a signed cookie for the length of the round trip, and the callback sends
// the browser there.
//
// THIS IS AN OPEN-REDIRECT SURFACE, so the rule is narrow: only a path on OUR
// origin. Not a URL with a scheme or host, not a protocol-relative `//evil`,
// not the `/\evil` that some browsers read as `//evil`, nothing with control
// characters, and nothing under /auth/ or /api/ (a redirect into the login
// route would loop, and the API is not a page). Anything else is dropped and
// the browser goes to the app's root, which is what happened before.

const MAX_LENGTH = 2048;

/** The path to return to after sign-in, or null when `raw` is not a safe one. */
export function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  // Backslashes are normalised to slashes by browsers; control characters
  // (tab, newline) are stripped by the URL parser and can join `/` and `/`.
  // Matching control characters is the point of this check.
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, 'http://return-to.invalid');
  } catch {
    return null;
  }
  // The parser is the final judge: whatever it resolved to must still be on
  // the placeholder origin, or the string named another host somehow.
  if (parsed.origin !== 'http://return-to.invalid') return null;
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (path === '/' || /^\/(auth|api)(\/|$)/.test(parsed.pathname)) return null;
  return path;
}

/** The absolute URL to send the browser to: `returnTo` on the SPA's origin, or its root. */
export function postLoginUrl(loginRedirectUrl: string, returnTo: string | null): string {
  if (!returnTo) return loginRedirectUrl;
  const base = new URL(loginRedirectUrl);
  return new URL(returnTo, base.origin).toString();
}

/** Cookie that carries `return_to` from the login route to the callback. */
export const RETURN_TO_COOKIE = 'auth_return_to';
