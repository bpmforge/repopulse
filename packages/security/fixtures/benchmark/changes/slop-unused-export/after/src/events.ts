import { parseIsoDate } from './dates.js';

export function eventDay(raw: { at: string }): number {
  return parseIsoDate(raw.at).getUTCDay();
}
