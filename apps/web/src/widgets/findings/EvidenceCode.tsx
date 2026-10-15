import { CodeBlock } from '../../components/code/index.js';
import type { Finding } from './contracts.js';

// A finding's evidence as highlighted, numbered code (W18-30).
//
// The evidence is a verbatim quote from the reviewed file, so its first line is
// the finding's first line. When the finding carries no line, the numbers are
// hidden rather than invented. The forge link stays where it was in the panel
// (with its commit/branch note); this block only shows what the quote says.
export function EvidenceCode({ finding }: { finding: Finding }) {
  const start = finding.line_range[0];
  const known = typeof start === 'number';
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
