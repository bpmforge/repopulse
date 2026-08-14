import { createHmac, timingSafeEqual } from 'node:crypto';

// Gitea webhook verification (FR-FORGE-6, SC-3).
//
// DIFFERS FROM GITHUB IN ONE IMPORTANT WAY, and the design doc flagged the
// semantics as UNVERIFIED for exactly this reason: Gitea sends
// `X-Gitea-Signature` as a BARE lowercase hex HMAC-SHA256 digest, with no
// `sha256=` prefix. GitHub sends `X-Hub-Signature-256: sha256=<hex>`.
//
// A shared implementation that assumed the prefix would reject every genuine
// Gitea delivery; one that merely stripped an optional prefix would accept a
// GitHub-shaped signature on a Gitea webhook. Keeping them separate keeps each
// strict about the format its forge actually sends.
//
// Verified against a live Gitea 1.x instance — see docs/research/gitea-webhooks.md.

/** Bare 64-char lowercase hex — the shape Gitea sends. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const received = signatureHeader.trim().toLowerCase();
  // Reject a prefixed (GitHub-shaped) signature outright rather than tolerating
  // it: accepting both formats would mean a caller could not tell which forge
  // actually signed a delivery.
  if (!HEX_SHA256.test(received)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; both are fixed-length hex here,
  // but the guard keeps that a returned false rather than a thrown error.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
