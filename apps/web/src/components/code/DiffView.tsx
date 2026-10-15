import { useEffect, useMemo, useRef, useState } from 'react';
import './code.css';
import { copyLabel, PathChip, renderTokens, useCopy, MAX_RENDERED_LINES } from './CodeBlock.js';
import { diffStat, parseUnifiedDiff, toSplitRows, type DiffFile, type DiffLine } from './parseDiff.js';
import { hasHiddenChars, languageFor, tokenizeLines } from './tokenize.js';

// A unified patch, drawn unified or side by side (W18-30).
//
// Split needs room: two 80-column halves want about 720px. The width that
// matters is the container's, not the window's, because the finding panel is
// narrower than the viewport. A ResizeObserver measures it; where there is none
// (jsdom) the view stays unified, which is the safe layout everywhere.

export const SPLIT_MIN_PX = 720;

export type DiffMode = 'auto' | 'unified' | 'split';

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
  tokens: ReturnType<typeof renderTokens> | null;
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

function FileDiff({ file, split }: { file: DiffFile; split: boolean }) {
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
      {file.hunks.map((h, hi) => {
        // Tokenise old and new sides separately so a block comment opened on a
        // removed line does not colour the added lines that follow it.
        const oldLines = h.lines.filter((l) => l.type !== 'add');
        const newLines = h.lines.filter((l) => l.type !== 'del');
        const oldTok = new Map(
          tokenizeLines(
            oldLines.map((l) => l.text),
            lang,
          ).map((t, i) => [oldLines[i]!, renderTokens(t)] as const),
        );
        const newTok = new Map(
          tokenizeLines(
            newLines.map((l) => l.text),
            lang,
          ).map((t, i) => [newLines[i]!, renderTokens(t)] as const),
        );
        const tokOf = (l: DiffLine) => (l.type === 'del' ? oldTok.get(l) : newTok.get(l)) ?? null;
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
}

export function DiffView({ diff, mode = 'auto', testId = 'diff-view' }: DiffViewProps) {
  const [chosen, setChosen] = useState<DiffMode>(mode);
  const [ref, width] = useContainerWidth();
  const [copied, copy] = useCopy();
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const hidden = useMemo(() => hasHiddenChars(diff), [diff]);
  const rowCount = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const tooBig = rowCount > MAX_RENDERED_LINES;
  const canSplit = width !== null && width >= SPLIT_MIN_PX;
  const split = chosen === 'split' ? canSplit : chosen === 'auto' ? canSplit : false;

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
            {canSplit ? (
              <>
                <button
                  type="button"
                  className="code-btn"
                  aria-pressed={!split}
                  data-testid="diff-unified"
                  onClick={() => setChosen('unified')}
                >
                  Unified
                </button>
                <button
                  type="button"
                  className="code-btn"
                  aria-pressed={split}
                  data-testid="diff-split"
                  onClick={() => setChosen('split')}
                >
                  Split
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="code-btn"
              data-testid="diff-copy"
              onClick={() => copy(diff)}
            >
              {copyLabel(copied, 'Copy patch')}
            </button>
          </span>
        </div>
        <div
          className="code-body"
          role="region"
          aria-label={`Patch, ${files.length === 1 ? (files[0]!.newPath || files[0]!.oldPath) : `${files.length} files`}`}
          tabIndex={0}
        >
          {tooBig ? (
            <p className="code-hunk" data-testid="diff-too-big">
              This patch has {rowCount} lines; use Copy patch to read it elsewhere.
            </p>
          ) : (
            files.map((f, i) => <FileDiff key={i} file={f} split={split} />)
          )}
        </div>
      </div>
    </div>
  );
}
