import { Fragment, type ReactNode } from 'react';

// W16-03 (F10). Report summary sections carry Markdown, and the print route
// dropped the raw string into a <p> — so the product's exportable deliverable,
// and the PDF built from it, rendered `**3 open findings**` and `` `act` ``
// with the asterisks and backticks showing.
//
// This is deliberately NOT a Markdown library. The assemblers emit exactly
// three constructs and nothing else — verified across every `markdown:` site in
// packages/reports/src/assembler:
//
//   **bold**        emphasis on counts, repo names, scores and band words
//   `code`          one site (risk.ts:112, the `act` band name)
//   blank line      paragraph break
//
// No headings, no lists, no links, no images, no HTML. A general renderer would
// add a dependency and an HTML-injection surface to interpret syntax that is
// never produced; this interprets the three and renders everything else as
// literal text, which React escapes. Report content is assembled by us from our
// own warehouse, but it embeds repository and org NAMES that came from a forge —
// so "the input is trusted" is not a claim worth resting on.
//
// If an assembler ever needs a fourth construct, add it here with a test rather
// than reaching for a parser: the whole point is that the grammar stays small
// enough to read.

/** Splits one line into bold / code / plain runs. */
function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, alternating: **...** or `...`. Non-greedy so adjacent spans do
  // not merge, and a lone ** or ` falls through to the literal text branch
  // rather than swallowing the rest of the paragraph.
  const pattern = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = pattern.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>);
    } else {
      out.push(
        <code key={`${keyPrefix}-c${i}`} className="rounded-sm bg-surface-2 px-1 font-mono text-xs">
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export interface ReportMarkdownProps {
  markdown: string;
  className?: string;
}

/** Renders a report summary section's Markdown subset. */
export function ReportMarkdown({ markdown, className }: ReportMarkdownProps) {
  // A blank line separates paragraphs; a single newline inside one is a soft
  // wrap the assemblers use only for source readability, so it collapses.
  const paragraphs = markdown.split(/\n{2,}/).filter((p) => p.trim() !== '');

  return (
    <div className={className} data-testid="report-markdown">
      {paragraphs.map((p, i) => (
        <p key={i} className={i > 0 ? 'mt-2 text-sm' : 'text-sm'}>
          {renderInline(p.replace(/\n/g, ' '), `p${i}`).map((node, j) => (
            <Fragment key={j}>{node}</Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}
