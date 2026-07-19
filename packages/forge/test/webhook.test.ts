import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../src/github/webhook.js';

const secret = 'shh-webhook-secret';
const body = Buffer.from(JSON.stringify({ action: 'opened', number: 1 }));
const validSig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhookSignature (SC-3, FR-FORGE-6)', () => {
  it('accepts a correct sha256 signature', () => {
    expect(verifyWebhookSignature(body, validSig, secret)).toBe(true);
  });

  it('rejects a mutated body', () => {
    const tampered = Buffer.from(JSON.stringify({ action: 'closed', number: 1 }));
    expect(verifyWebhookSignature(tampered, validSig, secret)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyWebhookSignature(body, validSig, 'wrong-secret')).toBe(false);
  });

  it('rejects a legacy sha1 (X-Hub-Signature) header outright', () => {
    const sha1 = 'sha1=' + createHmac('sha1', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, sha1, secret)).toBe(false);
  });

  it('rejects a malformed / empty signature header', () => {
    expect(verifyWebhookSignature(body, '', secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'garbage', secret)).toBe(false);
  });
});
