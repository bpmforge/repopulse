import { getJson } from './http.js';
import { withRetry } from './utils/retry.js';

export async function exchangeRate(from: string, to: string): Promise<unknown> {
  return withRetry(() => getJson(`https://rates.internal/${from}/${to}`), 3);
}
