import { strict as a } from 'node:assert';
import { afterEach, describe, expect, it, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { z } from 'zod';
import { total } from './cart.js';
import { expectRounded } from './support/expectations.js';

function checkTotal(items: number[], want: number): void {
  expect(total(items)).toBe(want);
}

const assertNonNegative = (n: number) => {
  if (n < 0) throw new Error(`negative: ${n}`);
};

function totalsTo(items: number[], want: number): void {
  checkTotal(items, want);
}

describe('cart', () => {
  it('uses expect', () => {
    expect(total([1, 2])).toBe(3);
  });

  it('uses a renamed node:assert', () => {
    a(total([1]) === 1);
  });

  it('calls a local helper that asserts', () => totalsTo([2, 2], 4));

  it('calls a helper that throws on a wrong answer', () => {
    assertNonNegative(total([5]));
  });

  it('calls an imported helper that asserts', () => {
    expectRounded(total([1.4]));
  });

  it.each([[1, 1]])('table %i', (n, want) => {
    checkTotal([n], want);
  });

  it('counts assertions up front', async () => {
    expect.assertions(1);
    await Promise.resolve(total([1])).then((t) => expect(t).toBe(1));
  });

  it('uses a query that throws when nothing matches', () => {
    render(null);
    screen.getByRole('button', { name: 'Checkout' });
  });

  it('waits on a done callback', (done) => {
    setTimeout(done, 1);
  });

  it('parses a valid schema input', () => {
    z.object({ id: z.string() }).parse({ id: 'a' });
  });

  it('checks a type at compile time', () => {
    // @ts-expect-error a string is not a number[]
    total('nope');
  });

  it('does not throw on an empty cart', () => {
    total([]);
  });

  test('ava-style context', (t: { is: (a: unknown, b: unknown) => void }) => {
    t.is(total([1]), 1);
  });

  test('tap-style destructured context', ({ same }: { same: (a: unknown, b: unknown) => void }) => {
    same(total([1]), 1);
  });

  it.todo('handles currencies');
  it.skip('handles refunds', () => {
    total([]);
  });
  test.describe('a playwright group', () => {});
});

describe('near-miss tautologies', () => {
  it('compares two different things', () => {
    const a1 = total([1]);
    const b1 = total([1]);
    expect(a1).toBe(b1);
    expect(total([1])).toBe(total([1]));
  });

  it('checks a getter is cached', () => {
    const cart = { get items() { return [1]; } };
    expect(cart.items).toBe(cart.items);
  });

  it('negates', () => {
    const x = total([1]);
    expect(x).not.toBe(x + 1);
    expect(0).toBeTruthy();
    expect('a b').not.toEqual('ab');
  });
});

describe('near-miss swallowed failures', () => {
  it('rethrows', () => {
    try {
      expect(total([1])).toBe(1);
    } catch (e) {
      console.error(e);
      throw e;
    }
  });

  it('asserts on the error', () => {
    try {
      total(null as unknown as number[]);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
    }
  });
});

describe('a hook asserts for every test', () => {
  afterEach(() => {
    expect(total([])).toBe(0);
  });
  it('relies on the hook', () => {
    total([1]);
  });
});
