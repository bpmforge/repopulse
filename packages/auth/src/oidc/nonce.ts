import { randomBytes } from 'node:crypto';

// `nonce` IS implemented, and the justification is that omitting it would cost
// more words than including it.
//
// state and nonce defend different things. state binds the callback to the
// browser that started the flow (CSRF); nonce binds the ID TOKEN to that same
// flow, so an id_token minted for a different login — replayed by anything that
// has ever seen one — cannot be presented as this one. The whole cost is one
// more field in a cookie we are already setting and one string comparison, and
// OIDC Core §3.1.2.1 requires it for the implicit flow precisely because token
// replay is a real class of bug rather than a theoretical one.
export function generateNonce(): string {
  return randomBytes(32).toString('base64url');
}
