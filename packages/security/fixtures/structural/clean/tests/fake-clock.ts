import type { Clock } from '../src/seams.js';

export class FakeClock implements Clock {
  now(): number {
    return 0;
  }
}
