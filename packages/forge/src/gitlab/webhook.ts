import { timingSafeEqual } from 'node:crypto';

// GitLab webhook verification (FR-FORGE-6, SC-3).
//
// A THIRD scheme, genuinely different from the other two: GitLab sends
// `X-Gitlab-Token`, the shared secret ITSELF, in plaintext. There is no HMAC
// and no signature over the body — GitHub signs with HMAC-SHA256 and Gitea
// sends a bare hex digest, but GitLab just echoes the token back.
//
// Consequences worth stating rather than discovering later:
//   - The comparison is still constant-time, because a naive === leaks the
//     secret one byte at a time to anyone who can time the endpoint.
//   - This scheme proves the SENDER knows the secret; it does NOT prove the
//     body is intact, so a GitLab delivery has weaker integrity guarantees than
//     a GitHub or Gitea one. That is GitLab's design, not something the adapter
//     can compensate for, and it is why transport TLS matters more here.
export function verifyWebhookToken(receivedToken: string, secret: string): boolean {
  const a = Buffer.from(receivedToken);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
