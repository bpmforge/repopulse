import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './code.css';
import { copyLabel, PathChip, renderTokens, useCopy, MAX_RENDERED_LINES } from './CodeBlock.js';
import {
  changedSpans,
  diffStat,
  hideWhitespaceOnly,
  parseUnifiedDiff,
  toSplitRows,
  type DiffFile,
  type DiffLine,
} from './parseDiff.js';
import { hasHiddenChars, languageFor, tokenizeLines, type Token } from './tokenize.js';

// A unified patch, drawn unified or side by side (W18-30).
//
// Split needs room: two 80-column halves want about 720px. The width that
// matters is the container's, not the window's, because the finding panel is
// narrower than the viewport. A ResizeObserver measures it; where there is none
// (jsdom) the view stays unified, which is the safe layout everywhere.

export const SPLIT_MIN_PX = 720;

export type DiffMode = 'auto' | 'unified' | 'split' | 'patch';

/** What a reader chose for diffs (W26-02): kept per browser when a storage key is given. */
interface DiffPrefs {
  mode: DiffMode;
  words: boolean;
  ws: boolean;
}

function readPrefs(key: string | undefined, fallback: DiffPrefs): DiffPrefs {
  if (!key) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<DiffPrefs>;
    const mode: DiffMode =
      v.mode === 'unified' || v.mode === 'split' || v.mode === 'patch' || v.mode === 'auto'
        ? v.mode
        : fallback.mode;
    return {
      mode,
      words: typeof v.words === 'boolean' ? v.words : fallback.words,
      ws: typeof v.ws === 'boolean' ? v.ws : fallback.ws,
    };
  } catch {
    return fallback;
  }
}

function writePrefs(key: string | undefined, prefs: DiffPrefs): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

/**
 * Tokens with the characters in [start, end) wrapped in a mark: the part of a
 * changed line that actually changed (W26-02), drawn over the syntax colours.
 */
function markTokens(tokens: readonly Token[], start: number, end: number): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  tokens.forEach((t, i) => {
    const from = at;
    const to = at + t.text.length;
    at = to;
    const cls = t.kind === 'plain' ? undefined : `tok-${t.kind}`;
    const piece = (text: string, k: string, marked: boolean) => {
      if (text === '') return;
      const inner = cls ? (
        <span key={k} className={cls}>
          {text}
        </span>
      ) : (
        text
      );
      out.push(
        marked ? (
          <mark key={`m${k}`} className="code-word">
            {inner}
          </mark>
        ) : cls ? (
          inner
        ) : (
          <span key={k}>{text}</span>
        ),
      );
    };
    const a = Math.max(from, Math.min(start, to));
    const b = Math.max(from, Math.min(end, to));
    piece(t.text.slice(0, a - from), `${i}a`, false);
    piece(t.text.slice(a - from, b - from), `${i}b`, true);
    piece(t.text.slice(b - from), `${i}c`, false);
  });
  return out;
}

function useContainerWidth(): [React.RefObject<HTMLDivElement>, number | null] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Cell({
  line,
  tokens,
  side,
}: {
  line: DiffLine | null;
  tokens: ReactNode;
  side: 'old' | 'new';
}) {
  if (!line) {
    return <div className="code-split-cell" data-kind="empty" aria-hidden="true" />;
  }
  const no = side === 'old' ? line.oldNo : line.newNo;
  return (
    <div className="code-split-cell" data-kind={line.type}>
      <span className="code-ln" data-line={no ?? ''} aria-hidden="true" />
      <span className="code-mark" aria-hidden="true">
        {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
      </span>
      <span className="code-text">
        {line.type === 'add' ? <span className="sr-only">added: </span> : null}
        {line.type === 'del' ? <span className="sr-only">removed: </span> : null}
        {tokens}
      </span>
    </div>
  );
}

function FileDiff({
  file,
  split,
  words,
  ws,
}: {
  file: DiffFile;
  split: boolean;
  words: boolean;
  ws: boolean;
}) {
  const path = file.newPath && file.newPath !== '/dev/null' ? file.newPath : file.oldPath;
  const lang = languageFor(path);
  const stat = diffStat([file]);
  return (
    <div data-testid="diff-file">
      <div className="code-file-head">
        <PathChip path={path} />
        <span className="code-stat-add">+{stat.added}</span>
        <span className="code-stat-del">−{stat.removed}</span>
      </div>
      {file.hunks.map((raw, hi) => {
        const h = ws ? { ...raw, lines: hideWhitespaceOnly(raw.lines) } : raw;
        const spans = words ? changedSpans(h.lines) : new Map<DiffLine, [number, number]>();
        // Tokenise old and new sides separately so a block comment opened on a
        // removed line does not colour the added lines that follow it.
        const oldLines = h.lines.filter((l) => l.type !== 'add');
        const newLines = h.lines.filter((l) => l.type !== 'del');
        const oldTok = new Map(
          tokenizeLines(
            oldLines.map((l) => l.text),
            lang,
          ).map((t, i) => [oldLines[i]!, t] as const),
        );
        const newTok = new Map(
          tokenizeLines(
            newLines.map((l) => l.text),
            lang,
          ).map((t, i) => [newLines[i]!, t] as const),
        );
        const render = (l: DiffLine, t: readonly Token[]) => {
          const span = spans.get(l);
          return span ? markTokens(t, span[0], span[1]) : renderTokens(t);
        };
        const tokOf = (l: DiffLine) => {
          const t = l.type === 'del' ? oldTok.get(l) : newTok.get(l);
          return t ? render(l, t) : null;
        };
        return (
          <div key={hi}>
            <div className="code-hunk" data-testid="diff-hunk">
              {h.header}
            </div>
            {split
              ? toSplitRows(h.lines).map((r, ri) => (
                  <div key={ri} className="code-split" data-testid="diff-row">
                    <Cell line={r.left} tokens={r.left ? tokOf(r.left) : null} side="old" />
                    <Cell line={r.right} tokens={r.right ? tokOf(r.right) : null} side="new" />
                  </div>
                ))
              : h.lines.map((l, li) => (
                  <div key={li} className="code-row" data-kind={l.type} data-testid="diff-row">
                    <span
                      className="code-ln"
                      data-line={(l.type === 'del' ? l.oldNo : l.newNo) ?? ''}
                      aria-hidden="true"
                    />
                    <span className="code-mark" aria-hidden="true">
                      {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}
                    </span>
                    <span className="code-text">
                      {l.type === 'add' ? <span className="sr-only">added: </span> : null}
                      {l.type === 'del' ? <span className="sr-only">removed: </span> : null}
                      {tokOf(l)}
                    </span>
                  </div>
                ))}
          </div>
        );
      })}
    </div>
  );
}

export interface DiffViewProps {
  /** A unified diff (what `git diff` or a model patch contains). */
  diff: string;
  mode?: DiffMode;
  testId?: string;
  /**
   * localStorage key for the reader's view choice (W26-02). Without one the
   * choice lasts as long as the component, which is what tests and one-off
   * diffs want.
   */
  storageKey?: string;
  /** False when the page offers its own Copy patch next to the diff (W26-02). */
  copyButton?: boolean;
}

export function DiffView({
  diff,
  mode = 'auto',
  testId = 'diff-view',
  storageKey,
  copyButton = true,
}: DiffViewProps) {
  const [prefs, setPrefs] = useState<DiffPrefs>(() =>
    readPrefs(storageKey, { mode, words: true, ws: false }),
  );
  const update = (next: Partial<DiffPrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    writePrefs(storageKey, merged);
  };
  const chosen = prefs.mode;
  const [ref, width] = useContainerWidth();
  const [copied, copy] = useCopy();
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const hidden = useMemo(() => hasHiddenChars(diff), [diff]);
  const rowCount = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const tooBig = rowCount > MAX_RENDERED_LINES;
  const canSplit = width !== null && width >= SPLIT_MIN_PX;
  const split = chosen === 'split' ? canSplit : chosen === 'auto' ? canSplit : false;
  const patchText = chosen === 'patch';

  // A patch we cannot parse is still shown, as text, never dropped.
  if (files.length === 0) {
    return (
      <div className="code-host" data-testid={testId}>
        <pre className="code-view code-body" data-testid="diff-raw">
          {diff}
        </pre>
      </div>
    );
  }

  return (
    <div className="code-host" data-testid={testId} ref={ref}>
      <div className="code-view">
        <div className="code-head">
          <span className="code-path" />
          {hidden ? (
            <span className="code-chip-warn" role="note" data-testid="code-hidden-chars">
              hidden characters
            </span>
          ) : null}
          <span className="code-actions">
            <span className="code-seg" role="group" aria-label="Diff view">
              <button
                type="button"
                className="code-btn"
                aria-pressed={!split && !patchText}
                data-testid="diff-unified"
                onClick={() => update({ mode: 'unified' })}
              >
                Unified
              </button>
              {canSplit ? (
                <button
                  type="button"
                  className="code-btn"
                  aria-pressed={split && !patchText}
                  data-testid="diff-split"
                  onClick={() => update({ mode: 'split' })}
                >
                  Split
                </button>
              ) : null}
              <button
                type="button"
                className="code-btn"
                aria-pressed={patchText}
                data-testid="diff-patch"
                onClick={() => update({ mode: 'patch' })}
              >
                Patch
              </button>
            </span>
            {patchText ? null : (
              <>
                <label className="code-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.words}
                    data-testid="diff-words"
                    onChange={(e) => update({ words: e.target.checked })}
                  />
                  Changed words
                </label>
                <label className="code-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.ws}
                    data-testid="diff-hide-ws"
                    onChange={(e) => update({ ws: e.target.checked })}
                  />
                  Hide whitespace
                </label>
              </>
            )}
            {copyButton ? (
              <button
                type="button"
                className="code-btn"
                data-testid="diff-copy"
                onClick={() => copy(diff)}
              >
                {copyLabel(copied, 'Copy patch')}
              </button>
            ) : null}
          </span>
        </div>
        <div
          className="code-body"
          role="region"
          aria-label={`Patch, ${files.length === 1 ? files[0]!.newPath || files[0]!.oldPath : `${files.length} files`}`}
          tabIndex={0}
        >
          {patchText ? (
            <pre className="code-patch" data-testid="diff-patch-text">
              {diff}
            </pre>
          ) : tooBig ? (
            <p className="code-hunk" data-testid="diff-too-big">
              This patch has {rowCount} lines; use Copy patch to read it elsewhere.
            </p>
          ) : (
            files.map((f, i) => (
              <FileDiff key={i} file={f} split={split} words={prefs.words} ws={prefs.ws} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
