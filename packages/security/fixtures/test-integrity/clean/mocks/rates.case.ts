import { expect, it, vi } from 'vitest';
import { rateFor } from './rates.js';

// A partial mock keeps the real module.
vi.mock('./rates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rates.js')>()),
}));

it('reads the eu rate', () => {
  expect(rateFor('eu')).toBe(0.2);
});
