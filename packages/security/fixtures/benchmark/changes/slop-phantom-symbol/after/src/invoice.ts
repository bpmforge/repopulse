import { formatAmount, formatCurrency } from './money.js';

export function invoiceLine(label: string, cents: number): string {
  return `${label}: ${formatAmount(cents, 'USD')}`;
}

export function totalLine(cents: number): string {
  return `Total: ${formatCurrency(cents)}`;
}
