import { useMemo, useState, type ReactNode } from 'react';
import './code.css';
import { hasHiddenChars, languageFor, languageLabel, tokenizeLines, type Token } from './tokenize.js';

// Highlighted, line-numbered code with an optional highlighted line range
// (W18-30). Used for a finding's evidence and, with DiffView, for patches.
//
// All text reaches the DOM as React text nodes. Nothing here uses
// dangerouslySetInnerHTML: finding text is untrusted.

/** Rendering cap: past this the forge link is the better tool. */
export const MAX_RENDERED_LINES = 2000;

export type CopyState = 'idle' | 'copied' | 'failed';

/** Clipboard write with an honest result; nothing leaves the browser. */
export function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle');
  const copy = (text: string) => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      setState('failed');
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => setState('copied'))
      .catch(() => setState('failed'));
  };
  return [state, copy];
}

export function copyLabel(state: CopyState, idle: string): string {
  return state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : idle;
}

export function renderTokens(tokens: readonly Token[]): ReactNode {
  return tokens.map((t, i) =>
    t.kind === 'plain' ? (
      t.text
    ) : (
      <span key={i} className={`tok-${t.kind}`}>
        {t.text}
      </span>
    ),
  );
}

export function PathChip({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const label = languageLabel(path);
  return (
    <span className="code-path">
      {label ? <span className="code-lang">{label}</span> : null}
      <span className="code-path-text" title={path}>
        <bdi>
          <span className="code-path-dir">{dir}</span>
          <span className="code-path-base">{base}</span>
        </bdi>
      </span>
    </span>
  );
}

export interface CodeBlockProps {
  code: string;
  /** Used for the header chip and to pick a language. */
  path?: string | null;
  /** Overrides the language picked from the path. */
  language?: string | null;
  /** Number of the first line in `code`. Defaults to 1; null when the line is not known, which hides the numbers rather than invent them. */
  startLine?: number | null;
  /** Inclusive line range to band, in the same numbering as `startLine`. */
  highlight?: { start: number; end: number } | null;
  /** Where "Open in forge" goes; the link is omitted when absent. */
  forgeUrl?: string | null;
  /** Footer text, e.g. which commit this was read at. */
  footer?: ReactNode;
  testId?: string;
}

export function CodeBlock({
  code,
  path,
  language,
  startLine = 1,
  highlight,
  forgeUrl,
  footer,
  testId = 'code-block',
}: CodeBlockProps) {
  const [wrap, setWrap] = useState(false);
  const [copied, copy] = useCopy();
  const all = useMemo(() => code.replace(/\r\n/g, '\n').split('\n'), [code]);
  const lines = all.length > MAX_RENDERED_LINES ? all.slice(0, MAX_RENDERED_LINES) : all;
  const truncated = all.length - lines.length;
  const lang = language ?? languageFor(path);
  const tokens = useMemo(() => tokenizeLines(lines, lang), [lines, lang]);
  const hidden = useMemo(() => hasHiddenChars(code), [code]);
  const rangeLabel =
    highlight && highlight.end > highlight.start
      ? `L${highlight.start}–${highlight.end}`
      : highlight
        ? `L${highlight.start}`
        : null;
  const aria = path
    ? `Code, ${path.split('/').pop()}${
        highlight
          ? highlight.end > highlight.start
            ? ` lines ${highlight.start} to ${highlight.end}`
            : ` line ${highlight.start}`
          : ''
      }`
    : 'Code';

  return (
    <div className="code-host" data-testid={testId}>
      <div className="code-view">
        <div className="code-head">
          {path ? <PathChip path={path} /> : <span className="code-path" />}
          {rangeLabel ? <span>{rangeLabel}</span> : null}
          {hidden ? (
            <span className="code-chip-warn" role="note" data-testid="code-hidden-chars">
              hidden characters
            </span>
          ) : null}
          <span className="code-actions">
            <button
              type="button"
              className="code-btn"
              aria-pressed={wrap}
              onClick={() => setWrap((w) => !w)}
            >
              Wrap
            </button>
            <button
              type="button"
              className="code-btn"
              data-testid="code-copy"
              onClick={() => copy(code)}
            >
              {copyLabel(copied, 'Copy')}
            </button>
            {forgeUrl ? (
              <a
                className="code-btn"
                href={forgeUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="code-forge-link"
              >
                Open in forge
              </a>
            ) : null}
          </span>
        </div>
        {/* A scroll container must be focusable or a keyboard user cannot scroll it. */}
        <div
          className="code-body"
          data-wrap={wrap}
          role="region"
          aria-label={aria}
          tabIndex={0}
        >
          {lines.map((_, i) => {
            const no = startLine === null ? null : startLine + i;
            const inRange =
              highlight && no !== null ? no >= highlight.start && no <= highlight.end : false;
            return (
              <div key={i} className="code-row" data-range={inRange} data-testid="code-row">
                <span className="code-ln" data-line={no ?? ''} aria-hidden="true" />
                <span className="code-mark" aria-hidden="true" />
                <span className="code-text">{renderTokens(tokens[i] ?? [])}</span>
              </div>
            );
          })}
        </div>
        {footer || truncated > 0 ? (
          <div className="code-foot">
            {truncated > 0 ? (
              <span data-testid="code-truncated">
                Showing the first {MAX_RENDERED_LINES} lines; {truncated} more are not shown.
              </span>
            ) : null}
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
