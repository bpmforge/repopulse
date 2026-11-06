import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { CodeBlock } from './CodeBlock.js';
import { DiffView } from './DiffView.js';
import {
  changedSpans,
  diffStat,
  hideWhitespaceOnly,
  parseUnifiedDiff,
  toSplitRows,
} from './parseDiff.js';
import { hasHiddenChars, languageFor, tokenizeLines } from './tokenize.js';

const BIDI = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);

const PATCH = [
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -10,4 +10,5 @@',
  ' function charge(id: string) {',
  "-  db.query('select * from t where id = ' + id);",
  '+  db.query(sql`select * from t where id = ${id}`);',
  '+  audit(id);',
  ' }',
].join('\n');

describe('languageFor', () => {
  it('maps extensions and returns null for unknown files', () => {
    expect(languageFor('src/a.ts')).toBe('js');
    expect(languageFor('x/y.PY')).toBe('py');
    expect(languageFor('README')).toBeNull();
    expect(languageFor(null)).toBeNull();
  });
});

describe('tokenizeLines', () => {
  it('colours keywords, strings, numbers, calls and comments', () => {
    const [line] = tokenizeLines(["const n = foo(42, 'x'); // hi"], 'js');
    const kinds = Object.fromEntries(line!.map((t) => [t.text.trim(), t.kind]));
    expect(kinds['const']).toBe('kw');
    expect(kinds['foo']).toBe('fn');
    expect(kinds['42']).toBe('num');
    expect(kinds["'x'"]).toBe('str');
    expect(kinds['// hi']).toBe('com');
  });

  it('carries a block comment across lines', () => {
    const out = tokenizeLines(['/* open', 'still comment', 'end */ x'], 'js');
    expect(out[1]![0]!.kind).toBe('com');
    expect(out[2]![0]!.kind).toBe('com');
  });

  it('never throws on an unterminated string or an unknown language', () => {
    expect(() => tokenizeLines(['"abc', "'\\"], 'js')).not.toThrow();
    expect(tokenizeLines(['anything goes'], null)[0]).toEqual([
      { text: 'anything goes', kind: 'plain' },
    ]);
  });

  it('reveals hidden characters even in an unknown language', () => {
    const [line] = tokenizeLines([`a${BIDI}b${ZWSP}c`], null);
    expect(line!.filter((t) => t.kind === 'hidden').map((t) => t.text)).toEqual([
      '‹U+202E›',
      '‹U+200B›',
    ]);
    expect(hasHiddenChars(`a${BIDI}`)).toBe(true);
    expect(hasHiddenChars('plain')).toBe(false);
  });
});

describe('parseUnifiedDiff', () => {
  it('numbers old and new lines from the hunk header', () => {
    const [f] = parseUnifiedDiff(PATCH);
    expect(f!.newPath).toBe('src/pay.ts');
    const lines = f!.hunks[0]!.lines;
    expect(lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
    ]);
    expect(diffStat([f!])).toEqual({ added: 2, removed: 1 });
  });

  it('pairs removed and added lines for the split view', () => {
    const rows = toSplitRows(parseUnifiedDiff(PATCH)[0]!.hunks[0]!.lines);
    expect(rows).toHaveLength(4);
    expect(rows[1]!.left?.type).toBe('del');
    expect(rows[1]!.right?.type).toBe('add');
    expect(rows[2]!.left).toBeNull();
    expect(rows[2]!.right?.type).toBe('add');
  });

  it('returns nothing for text that is not a diff', () => {
    expect(parseUnifiedDiff('just some prose')).toEqual([]);
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('CodeBlock', () => {
  it('shows numbered rows, a path chip and a banded range', () => {
    render(
      <CodeBlock
        code={'a()\nb()'}
        path="src/payments/charge.ts"
        startLine={10}
        highlight={{ start: 10, end: 11 }}
      />,
    );
    const rows = screen.getAllByTestId('code-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.code-ln')!.getAttribute('data-line')).toBe('10');
    expect(rows[1]!.querySelector('.code-ln')!.getAttribute('data-line')).toBe('11');
    expect(rows[0]!.getAttribute('data-range')).toBe('true');
    expect(screen.getByText('charge.ts')).toBeInTheDocument();
    expect(screen.getByText('L10–11')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /charge\.ts lines 10 to 11/ })).toBeInTheDocument();
  });

  it('hides the numbers rather than invent them when the line is unknown', () => {
    render(<CodeBlock code="x" startLine={null} />);
    expect(
      screen.getByTestId('code-row').querySelector('.code-ln')!.getAttribute('data-line'),
    ).toBe('');
  });

  it('renders markup in the code as text, never as elements', () => {
    const { container } = render(<CodeBlock code={'<img src=x onerror=alert(1)>'} path="a.ts" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('flags hidden characters in the header', () => {
    render(<CodeBlock code={`a${BIDI}b`} />);
    expect(screen.getByTestId('code-hidden-chars')).toBeInTheDocument();
  });

  it('offers the forge link only when there is one', () => {
    const { rerender } = render(<CodeBlock code="x" />);
    expect(screen.queryByTestId('code-forge-link')).toBeNull();
    rerender(<CodeBlock code="x" forgeUrl="https://example.test/blob/abc/a.ts#L1" />);
    expect(screen.getByTestId('code-forge-link')).toHaveAttribute(
      'href',
      'https://example.test/blob/abc/a.ts#L1',
    );
  });

  it('caps the rendered lines and says so', () => {
    render(<CodeBlock code={Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n')} />);
    expect(screen.getAllByTestId('code-row')).toHaveLength(2000);
    expect(screen.getByTestId('code-truncated')).toHaveTextContent('500 more');
  });
});

describe('DiffView', () => {
  it('shows added and removed rows with marks and screen-reader prefixes', () => {
    render(<DiffView diff={PATCH} />);
    const rows = screen.getAllByTestId('diff-row');
    expect(rows).toHaveLength(5);
    expect(rows[1]!.getAttribute('data-kind')).toBe('del');
    expect(within(rows[1]!).getByText('removed:')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('added:')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
    expect(screen.getByTestId('diff-hunk')).toHaveTextContent('@@ -10,4 +10,5 @@');
  });

  it('stays unified when the container width is unknown (no ResizeObserver)', () => {
    render(<DiffView diff={PATCH} mode="split" />);
    expect(screen.queryByTestId('diff-split')).toBeNull();
    expect(screen.getAllByTestId('diff-row')).toHaveLength(5);
  });

  it('shows a patch it cannot parse as text instead of dropping it', () => {
    render(<DiffView diff="not a diff at all" />);
    expect(screen.getByTestId('diff-raw')).toHaveTextContent('not a diff at all');
  });
});

describe('DiffView split layout', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubWidth(width: number) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
        observe() {
          this.cb([{ contentRect: { width } }]);
        }
        disconnect() {}
      },
    );
  }

  it('goes side by side in a wide container, and the toggle goes back', async () => {
    stubWidth(900);
    render(<DiffView diff={PATCH} />);
    // 4 split rows: ctx, del|add, empty|add, ctx
    expect(await screen.findAllByTestId('diff-row')).toHaveLength(4);
    await userEvent.click(screen.getByTestId('diff-unified'));
    expect(screen.getAllByTestId('diff-row')).toHaveLength(5);
  });

  it('stays unified in a narrow container and offers no split toggle', () => {
    stubWidth(400);
    render(<DiffView diff={PATCH} mode="split" />);
    expect(screen.queryByTestId('diff-split')).toBeNull();
    expect(screen.getAllByTestId('diff-row')).toHaveLength(5);
  });
});

// W26-02: a reader picks how a diff is drawn, and the choice can be kept.
describe('DiffView options', () => {
  afterEach(() => window.localStorage.clear());

  it('shows the raw patch text under Patch', async () => {
    render(<DiffView diff={PATCH} />);
    await userEvent.click(screen.getByTestId('diff-patch'));
    expect(screen.getByTestId('diff-patch-text').textContent).toBe(PATCH);
    expect(screen.queryAllByTestId('diff-row')).toHaveLength(0);
    expect(screen.queryByTestId('diff-words')).toBeNull();
    await userEvent.click(screen.getByTestId('diff-unified'));
    expect(screen.getAllByTestId('diff-row')).toHaveLength(5);
  });

  it('marks the changed part of a changed line, and stops when turned off', async () => {
    render(<DiffView diff={PATCH} />);
    const marks = document.querySelectorAll('mark.code-word');
    expect(marks.length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('diff-words'));
    expect(document.querySelectorAll('mark.code-word')).toHaveLength(0);
  });

  it('keeps the choice under a storage key and reads it back', async () => {
    const { unmount } = render(<DiffView diff={PATCH} storageKey="t.diff" />);
    await userEvent.click(screen.getByTestId('diff-patch'));
    unmount();
    render(<DiffView diff={PATCH} storageKey="t.diff" />);
    expect(screen.getByTestId('diff-patch-text')).toBeInTheDocument();
  });

  it('ignores a stored value it does not understand', () => {
    window.localStorage.setItem('t.diff', '{"mode":"sideways","words":"yes"}');
    render(<DiffView diff={PATCH} storageKey="t.diff" />);
    expect(screen.getAllByTestId('diff-row')).toHaveLength(5);
  });
});

describe('changedSpans and hideWhitespaceOnly', () => {
  const lines = parseUnifiedDiff(
    ['@@ -1,2 +1,2 @@', '-  val, _ := f(x)', '+  val, err := f(x)', '-a  b', '+a b'].join('\n'),
  )[0]!.hunks[0]!.lines;

  it('finds the characters between the common prefix and suffix', () => {
    const spans = changedSpans(lines);
    expect(spans.get(lines[0]!)).toEqual([7, 8]); // "_"
    expect(spans.get(lines[1]!)).toEqual([7, 10]); // "err"
  });

  it('pairs each run of removed lines with the added run after it', () => {
    const spans = changedSpans(lines);
    expect(spans.get(lines[2]!)).toEqual([2, 3]); // the extra space
    expect(spans.has(lines[3]!)).toBe(false); // nothing was inserted on the new side
  });

  it('shows a whitespace-only change once, as unchanged', () => {
    const out = hideWhitespaceOnly(lines);
    expect(out.map((l) => l.type)).toEqual(['del', 'add', 'ctx']);
    expect(out[2]!.oldNo).toBe(2);
    expect(out[2]!.text).toBe('a b');
  });
});
