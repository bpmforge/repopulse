import { CodeBlock } from '../../components/code/index.js';
import type { Finding } from './contracts.js';

// A finding's code as highlighted, numbered lines (W18-30, W18-32).
//
// When the scan stored lines around the finding, those are shown, with the
// finding's own range banded. Otherwise the evidence quote is shown: a verbatim
// quote from the reviewed file, so its first line is the finding's first line.
// When no line is known the numbers are hidden rather than invented. The forge
// link stays in the panel, with its commit/branch note.
export function EvidenceCode({ finding }: { finding: Finding }) {
  const start = finding.line_range[0];
  const end = finding.line_range[1];
  const known = typeof start === 'number';
  const ctx = finding.context;
  if (ctx && ctx.lines !== '') {
    return (
      <CodeBlock
        code={ctx.lines}
        path={finding.file}
        startLine={ctx.start_line}
        highlight={known ? { start, end: typeof end === 'number' ? end : start } : null}
        testId="finding-evidence"
        footer={
          <span data-testid="finding-context-note">
            As scanned. The file may have changed since.
          </span>
        }
      />
    );
  }
  const lineCount = finding.evidence.split('\n').length;
  return (
    <CodeBlock
      code={finding.evidence}
      path={finding.file}
      startLine={known ? start : null}
      highlight={known ? { start, end: start + lineCount - 1 } : null}
      testId="finding-evidence"
    />
  );
}
