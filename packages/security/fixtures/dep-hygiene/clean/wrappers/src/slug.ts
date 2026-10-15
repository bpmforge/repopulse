import slugifyLib from 'slugify';

// Delegates: the name matches, the work is the library's.
export const slugify = (text: string): string => slugifyLib(text, { lower: true, strict: true });

// Same name, unrelated job: no string normalisation happens here.
export function throttle(limit: number): number {
  return Math.min(limit, 10);
}
