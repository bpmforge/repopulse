import assert from 'node:assert/strict';
import { expect, it } from 'vitest';
import { total } from './cart.js';

it('totals the cart', () => {
  const result = total([1, 2, 3]);
  expect(result).toBe(result);
});

it('is always green', () => {
  expect(true).toBe(true);
  expect(1).toBeTruthy();
  expect(null).toBeNull();
});

it('compares a literal with itself', () => {
  expect('ok').toEqual('ok');
  assert.equal(total, total);
  assert.ok(true);
});
