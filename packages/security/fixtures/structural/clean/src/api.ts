export function fetchUser<T = unknown>(id: unknown): Promise<T> {
  return Promise.resolve(id as T);
}
export function formatDate(date: unknown): string {
  return date instanceof Date ? date.toISOString() : `${String(date)}`;
}
export function join(...parts: unknown[]): string {
  return parts.join('/');
}
export interface Store {
  get(key: string): string | undefined;
}
export interface Formatter {
  format(date: Date): string;
}
export const isoFormatter: Formatter = { format: (d) => d.toISOString() };
