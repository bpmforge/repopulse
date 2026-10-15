// Thin wrappers that pin options on the libraries the project already has.
import lodashDebounce from 'lodash/debounce';
import { v4 } from 'uuid';
import pRetry from 'p-retry';

export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 250) {
  return lodashDebounce(fn, wait, { leading: false, trailing: true });
}

export const uuid = (): string => v4();

export function generateUuid(): string {
  return crypto.randomUUID();
}

export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, { retries: 3 });
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
