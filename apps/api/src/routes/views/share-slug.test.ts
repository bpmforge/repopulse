import { describe, expect, it } from 'vitest';
import { generateShareSlug } from './share-slug.js';

describe('generateShareSlug (SC-17)', () => {
  it('is 128 bits, hex-encoded (32 chars)', () => {
    expect(generateShareSlug()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is unique across many calls', () => {
    const slugs = new Set(Array.from({ length: 1000 }, () => generateShareSlug()));
    expect(slugs.size).toBe(1000);
  });
});
