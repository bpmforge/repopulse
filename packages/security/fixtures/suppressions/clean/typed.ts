import { load } from './store';

// Near misses: every line here either names what it silences and why, or only
// looks like a suppression.
const anyOf = (xs: unknown[]): boolean => xs.length > 0;
const anyway: number = 1;
const pattern = /as any/;
const prose = 'cast it with as any and add // @ts-ignore';
const template = `${anyway} as any: any <any>`;

export function read(raw: unknown): string {
  const parsed = JSON.parse(String(raw)) as unknown as { items: string[]; count: number };
  // do not reach for @ts-ignore here; narrow the type instead
  // @ts-expect-error -- the upstream typing omits `count`; fixed in v3
  const count: number = parsed.count;
  // @ts-expect-error: deliberate wrong type, the test below asserts the throw
  const wrong: string = 1;
  // eslint-disable-next-line no-console
  console.info(count, wrong);
  // eslint-disable-next-line no-console -- startup banner, not logging
  console.info(prose, template, pattern, anyOf([]));
  /* eslint-enable */
  // biome-ignore lint/suspicious/noExplicitAny: the plugin API is untyped upstream
  const store = load(parsed.items[0]);
  /**
   * @ts-ignore inside a doc block is prose, not a directive
   */
  return String(store);
}
