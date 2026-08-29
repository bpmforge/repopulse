import { describe, expect, it } from 'vitest';
import { locationOf } from './contracts.js';

// Where a finding IS, in words (W16-40).
//
// Not every finding is about a line of code. A test-gap or ownership register
// reports on a REPOSITORY, and those rows carry file: null with a null line
// range — which both screens rendered as `{file}:{line}`, printing a bare
// colon. Seen in the demo: three rows whose File column read ":".
//
// Punctuation with nothing either side of it reads as a rendering bug, and
// tells the reader nothing about a finding that is perfectly well located.

describe('locationOf', () => {
  it('names the repository when there is no file', () => {
    expect(locationOf({ file: null, line_range: [null, null] })).toBe('whole repository');
  });

  it('gives file and line for an ordinary finding', () => {
    expect(locationOf({ file: 'src/service.ts', line_range: [15, 19] })).toBe(
      'src/service.ts:15–19',
    );
  });

  it('says one number for a single-line finding, not "10–10"', () => {
    expect(locationOf({ file: 'src/index.ts', line_range: [10, 10] })).toBe('src/index.ts:10');
    expect(locationOf({ file: 'src/index.ts', line_range: [10, null] })).toBe('src/index.ts:10');
  });

  it('falls back to the file alone when the line is unknown', () => {
    // A file with no line is still a location; inventing line 0 would be a
    // claim, and a trailing colon would be the bug this function exists for.
    expect(locationOf({ file: 'src/index.ts', line_range: [null, null] })).toBe('src/index.ts');
  });

  it('never emits a bare colon, whatever it is given', () => {
    for (const f of [
      { file: null, line_range: [null, null] },
      { file: '', line_range: [null, null] },
      { file: null, line_range: [1, 2] },
    ]) {
      expect(locationOf(f)).not.toMatch(/^:|:$/);
      expect(locationOf(f).trim()).not.toBe(':');
    }
  });
});
