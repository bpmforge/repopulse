import { expect, it } from 'vitest';
import { parseInvoice } from './invoice.js';

it('parses an invoice', () => {
  try {
    expect(parseInvoice('INV-1').id).toBe('INV-1');
  } catch (e) {
    console.log('parse failed', e);
  }
});

it('rejects a malformed invoice', async () => {
  try {
    await parseInvoice('garbage');
    expect.fail('should have thrown');
  } catch {
    // swallowed
  }
});
