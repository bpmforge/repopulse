import { describe, expect, it } from 'vitest';
import { tokenExpiryText, tokenOwnerText } from './forge-token.js';
import { verifiedByText } from '../findings/contracts.js';

// W20-25. ADM-50: whose token a connection runs on and when it stops working,
// in words. X-10: which model judged a finding, beside "Found by".

const now = Date.parse('2026-10-22T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const base = { status: 'active', auth_kind: 'pat', token_checked_at: '2026-10-01T00:00:00Z' };

describe('Connections token cells (ADM-50)', () => {
  it('names the owner, or says why there is none', () => {
    expect(tokenOwnerText({ ...base, token_owner: 'ada' })).toBe('ada');
    expect(tokenOwnerText({ ...base, token_owner: null })).toBe('owner not reported');
    expect(tokenOwnerText({ ...base, token_checked_at: null })).toMatch(/Not read yet/);
    expect(tokenOwnerText({ ...base, auth_kind: 'app' })).toBe('App installation');
    expect(tokenOwnerText({ ...base, status: 'removed' })).toBe('—');
  });

  it('says when the token expires, or that the forge gave no expiry', () => {
    expect(
      tokenExpiryText({ ...base, token_expires_at: new Date(now + 10 * DAY).toISOString() }, now),
    ).toBe('expires in 10 days');
    expect(
      tokenExpiryText({ ...base, token_expires_at: new Date(now - 2 * DAY).toISOString() }, now),
    ).toBe('expired 2 days ago');
    expect(tokenExpiryText({ ...base, token_expires_at: null }, now)).toBe('No expiry reported');
    expect(tokenExpiryText({ ...base, token_checked_at: null }, now)).toBe('—');
  });
});

describe('verifiedByText (X-10)', () => {
  it('names the model, the connection and what it said', () => {
    expect(
      verifiedByText({ model: 'local-x', connection: 'Workstation', verdict: 'real', at: null }),
    ).toBe('verified by local-x (Workstation): judged real');
    expect(verifiedByText({ model: 'local-x', connection: null, verdict: null, at: null })).toBe(
      'verified by local-x',
    );
    expect(verifiedByText(null)).toBeNull();
    expect(verifiedByText(undefined)).toBeNull();
  });

  it('W21-03: states a second-model verdict, a contradiction as left open', () => {
    expect(
      verifiedByText({ model: 'judge-b', connection: 'Box B', verdict: 'contradicted', at: null }),
    ).toBe('verified by judge-b (Box B): contradicted, left open for a person to decide');
    expect(
      verifiedByText({ model: 'judge-b', connection: null, verdict: 'confirmed', at: null }),
    ).toBe('verified by judge-b: confirmed');
  });
});
