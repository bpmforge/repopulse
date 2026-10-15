import { expect } from 'vitest';

export function expectValidTotal(value: number): void {
  expect(value).toBeGreaterThanOrEqual(0);
}

export const expectRounded = (value: number): void => expectValidTotal(Math.round(value));
