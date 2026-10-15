import { getJson } from './http.js';

export async function exchangeRate(from: string, to: string): Promise<unknown> {
  return getJson(`https://rates.internal/${from}/${to}`);
}
