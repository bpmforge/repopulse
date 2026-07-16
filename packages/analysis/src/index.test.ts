import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('analysis package placeholder', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@repopulse/analysis');
  });
});
