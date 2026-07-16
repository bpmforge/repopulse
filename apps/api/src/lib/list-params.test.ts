import { describe, expect, it } from 'vitest';
import { cursorPaginationSchema, listQuerySchema, listResponseSchema } from './list-params.js';
import { z } from 'zod';

describe('cursorPaginationSchema', () => {
  it('defaults limit to 20 when absent', () => {
    expect(cursorPaginationSchema.parse({})).toEqual({ limit: 20 });
  });

  it('coerces a numeric-string limit and rejects out-of-range values', () => {
    expect(cursorPaginationSchema.parse({ limit: '50' })).toMatchObject({ limit: 50 });
    expect(() => cursorPaginationSchema.parse({ limit: '101' })).toThrow();
    expect(() => cursorPaginationSchema.parse({ limit: '0' })).toThrow();
  });
});

describe('listQuerySchema', () => {
  it('defaults window to 30d and leaves repo_ids undefined when absent', () => {
    const parsed = listQuerySchema.parse({});
    expect(parsed.window).toBe('30d');
    expect(parsed.repo_ids).toBeUndefined();
  });

  it('splits a comma-separated repo_ids into numbers', () => {
    const parsed = listQuerySchema.parse({ repo_ids: '1,2,3' });
    expect(parsed.repo_ids).toEqual([1, 2, 3]);
  });

  it('rejects an invalid window value', () => {
    expect(() => listQuerySchema.parse({ window: '3d' })).toThrow();
  });
});

describe('listResponseSchema', () => {
  it('validates the {items, next_cursor} envelope', () => {
    const schema = listResponseSchema(z.object({ id: z.number() }));
    expect(schema.parse({ items: [{ id: 1 }], next_cursor: null })).toEqual({
      items: [{ id: 1 }],
      next_cursor: null,
    });
    expect(() => schema.parse({ items: [{ id: 1 }] })).toThrow();
  });
});
