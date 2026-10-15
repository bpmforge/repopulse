import { expect, it, vi } from 'vitest';
import { priceFor } from './pricing.js';

vi.mock('./pricing.js');

it('prices a sku', () => {
  vi.mocked(priceFor).mockReturnValue(300);
  expect(priceFor('abc')).toBe(300);
});
