import { expect, it, vi } from 'vitest';
import { rateFor } from './rates.js';
import { tax } from './tax.js';

// Mocks a COLLABORATOR, not the subject.
vi.mock('./rates.js');

it('applies the regional rate', () => {
  vi.mocked(rateFor).mockReturnValue(0.5);
  expect(tax(10, 'eu')).toBe(5);
});
