import { formatAmount } from './money.js';

export function invoiceLine(label: string, cents: number): string {
  return `${label}: ${formatAmount(cents, 'USD')}`;
}
