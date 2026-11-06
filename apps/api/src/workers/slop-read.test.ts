import { describe, expect, it } from 'vitest';
import { partialReadReason, SLOP_MAX_FILES } from './slop-read.js';

describe('a partial anti-slop read says why (W25-08)', () => {
  it('names the read cap and the files skipped for size', () => {
    const msg = partialReadReason({ files: new Array(2000), skipped: 3, truncated: true }, 2000);
    expect(msg).toMatch(/stopped after 2,000 files/);
    expect(msg).toMatch(/3 files were skipped for being over 512 KB/);
  });
  it('names only what happened', () => {
    const msg = partialReadReason({ files: [], skipped: 1, truncated: false }, SLOP_MAX_FILES);
    expect(msg).not.toMatch(/stopped after/);
    expect(msg).toMatch(/1 file was skipped/);
  });
  it('reads far more than the 2,000 files that cut saleor and outline short', () => {
    expect(SLOP_MAX_FILES).toBeGreaterThanOrEqual(10_000);
  });
});
