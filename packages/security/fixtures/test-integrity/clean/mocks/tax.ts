import { rateFor } from './rates.js';
export const tax = (amount: number, region: string): number => amount * rateFor(region);
