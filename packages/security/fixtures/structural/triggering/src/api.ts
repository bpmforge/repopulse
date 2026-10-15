export function fetchUser(id: string): Promise<unknown> {
  return Promise.resolve({ id });
}
export function formatDate(date: Date): string {
  return date.toISOString();
}
export function join(...parts: string[]): string {
  return parts.join('/');
}
