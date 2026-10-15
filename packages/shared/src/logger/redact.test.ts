import { describe, expect, it } from 'vitest';
import { redactLine } from './redact.js';

describe('redactLine (SC-2 no-log rule)', () => {
  it('redacts a "token"-keyed value regardless of exact key name', () => {
    const line = '{"level":30,"accessToken":"abc123","msg":"login"}';
    const redacted = redactLine(line);
    expect(redacted).not.toContain('abc123');
    expect(redacted).toContain('"accessToken":"[REDACTED]"');
  });

  it('redacts credential/secret/authorization/password/x-hub-signature keys', () => {
    const line = JSON.stringify({
      credentialCiphertext: 'cipherbytes',
      webhookSecretCiphertext: 'secretbytes',
      authorization: 'Bearer xyz',
      password: 'hunter2',
      'x-hub-signature-256': 'sha256=deadbeef',
    });
    const redacted = redactLine(line);
    for (const leaked of ['cipherbytes', 'secretbytes', 'Bearer xyz', 'hunter2', 'deadbeef']) {
      expect(redacted).not.toContain(leaked);
    }
  });

  it('scrubs a bare GitHub PAT wherever it appears, even outside a denylisted key', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const line = JSON.stringify({ msg: `oauth exchange returned ${token} unexpectedly` });
    const redacted = redactLine(line);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('[REDACTED-TOKEN]');
  });

  it('scrubs a bare RepoPulse CI token (W18-18) wherever it appears', () => {
    const token = 'rpci_' + 'Ab9-_'.repeat(9);
    const line = JSON.stringify({ msg: `curl -H "Bearer ${token}" failed` });
    const redacted = redactLine(line);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('[REDACTED-TOKEN]');
  });

  it('scrubs a PEM block (GitHub App private key)', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\\nMIIEow==\\n-----END RSA PRIVATE KEY-----';
    const line = `{"msg":"loaded key","key":"${pem}"}`;
    const redacted = redactLine(line);
    expect(redacted).not.toContain('MIIEow==');
    expect(redacted).toContain('[REDACTED-PEM]');
  });

  it('leaves ordinary fields untouched', () => {
    const line = JSON.stringify({ level: 30, msg: 'request completed', statusCode: 200 });
    expect(redactLine(line)).toBe(line);
  });
});
