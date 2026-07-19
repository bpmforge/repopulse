import { describe, expect, it } from 'vitest';
import { identityKey } from './identity.js';

describe('identityKey (DATABASE §2 note 4)', () => {
  it('uses the forge login when present', () => {
    expect(identityKey({ login: 'alice' })).toBe('alice');
  });

  it('falls back to email:{address} for a null-login (email-only) commit', () => {
    expect(identityKey({ login: null, email: 'bob@x.com' })).toBe('email:bob@x.com');
  });

  it('falls back to email:unknown when neither login nor email is available', () => {
    expect(identityKey({ login: null })).toBe('email:unknown');
    expect(identityKey({ login: '', email: '' })).toBe('email:unknown');
  });
});
