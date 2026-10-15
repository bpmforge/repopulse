import { describe, it, test } from 'vitest';
import { applyDiscount } from './discount.js';

function runScenario(price: number): void {
  applyDiscount(price, 0.1);
}

describe('applyDiscount', () => {
  it('applies a ten percent discount', () => {
    applyDiscount(100, 0.1);
  });

  it('handles a zero price', async () => {
    const result = applyDiscount(0, 0.5);
    console.log(result);
  });

  it.each([10, 20, 30])('discounts %i', (price) => {
    applyDiscount(price, 0.2);
  });

  test('is not written yet', () => {});

  it('runs the shared scenario', runScenario);

  it('passes a reference to a helper that asserts nothing', () => runScenario(10));
});
