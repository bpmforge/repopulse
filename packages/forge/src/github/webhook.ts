import { createHmac, timingSafeEqual } from 'node:crypto';

// verifyWebhook (FR-FORGE-6, SC-3): X-Hub-Signature-256 = HMAC-SHA256 over the
// RAW body, compared with crypto.timingSafeEqual. Legacy SHA-1
// (X-Hub-Signature) is ignored outright.
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first, still constant-time
  // for equal-length (the only case an attacker controls once length is fixed).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
