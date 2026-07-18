import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor encode/decode', () => {
  it('round-trips an id', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });

  it('is opaque (not a plain integer string)', () => {
    expect(encodeCursor(100)).not.toBe('100');
  });

  it('rejects garbage input', () => {
    expect(decodeCursor('not-valid-base64url-!!!')).toBeNull();
    expect(decodeCursor(encodeCursor(0))).toBeNull();
  });
});
