import { describe, expect, it } from 'vitest';
import { titleFromMessage } from './output.js';

// 2026-10-27 walkthrough: every performance, logging and rule-pack finding was
// titled with its rule id ("bpm-perf-sw-find-in-loop"), 812 rows in one
// workspace. The title is now the message's opening sentence.
describe('titleFromMessage', () => {
  it('takes the first sentence of a rule message', () => {
    expect(
      titleFromMessage(
        'A Core Data fetch inside a loop. Each fetch is a trip to the store, so N items means N queries.',
        'bpm-perf-sw-fetch-in-loop',
      ),
    ).toBe('A Core Data fetch inside a loop.');
  });

  it('does not stop at an abbreviation or a mid-sentence full stop', () => {
    expect(
      titleFromMessage(
        'Request data reaches a log call unencoded (CWE-117), e.g. a header. A newline forges a line.',
        'bpm-log-injection',
      ),
    ).toBe('Request data reaches a log call unencoded (CWE-117), e.g. a header.');
  });

  it('reads folded YAML whitespace as single spaces', () => {
    expect(titleFromMessage('panic() on an error,\n  inside a function.\n  More.', 'x')).toBe(
      'panic() on an error, inside a function.',
    );
  });

  it('clips a long first sentence at a word', () => {
    const long = `${'word '.repeat(40)}end. Next.`;
    const title = titleFromMessage(long, 'x');
    expect(title.length).toBeLessThanOrEqual(121);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });

  it('ends a long sentence at its em dash rather than mid-clause', () => {
    expect(
      titleFromMessage(
        'strncpy does not terminate the destination when the source is at least as long as the count — and nothing after this call adds the terminator, so later reads run off the end.',
        'bpm-c-strncpy-unterminated',
      ),
    ).toBe(
      'strncpy does not terminate the destination when the source is at least as long as the count.',
    );
  });

  it('keeps Ruby and Rust names that end in ! whole', () => {
    expect(titleFromMessage('params.permit! marks every parameter as safe. More.', 'x')).toBe(
      'params.permit! marks every parameter as safe.',
    );
  });

  it('falls back to the rule id when there is no message', () => {
    expect(titleFromMessage('  ', 'bpm-rule')).toBe('bpm-rule');
  });
});
