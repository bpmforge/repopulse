import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('metrics package placeholder', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@repopulse/metrics');
  });
});
