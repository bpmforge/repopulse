/* eslint-disable */
// @ts-nocheck
import { load } from './store';

export function read(raw: any): string {
  const parsed = JSON.parse(raw) as any;
  const list = <any>parsed.items;
  // @ts-ignore
  const first = list[0].name;
  // @ts-expect-error
  const count: number = parsed.count;
  // eslint-disable-next-line
  const store = load(first, count);
  const tail = store.rest; // eslint-disable-line -- no rule named, only a description
  // biome-ignore lint/suspicious/noExplicitAny
  const extra: Promise<any> = store.more;
  return String(tail) + String(extra);
}
