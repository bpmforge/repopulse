// Half of a deliberate import cycle (W10-03 fixture).
import { priceOf } from './pricing.js';
import { log } from './hub.js';

export function total(order) {
  log('total');
  return order.items.reduce((sum, item) => sum + priceOf(item), 0);
}
