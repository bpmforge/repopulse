// The other half of the cycle: pricing asks orders for the discount rules.
import { total } from './orders.js';
import { log } from './hub.js';

export function priceOf(item) {
  log('price');
  return item.price - (total.discount ?? 0);
}
