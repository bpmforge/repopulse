import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvidenceCode } from './EvidenceCode.js';
import type { Finding } from './contracts.js';

function finding(over: Partial<Finding>): Finding {
  return {
    file: 'src/pay.ts',
    line_range: [10, 11],
    evidence: 'src/pay.ts:10 — bpm-rule',
    ...over,
  } as Finding;
}

describe('EvidenceCode (W18-32)', () => {
  it('shows the stored lines, numbered from their start, with the finding range banded', () => {
    render(
      <EvidenceCode
        finding={finding({ context: { start_line: 8, lines: 'a()\nb()\nc()\nd()\ne()' } })}
      />,
    );
    const rows = screen.getAllByTestId('code-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]!.querySelector('.code-ln')!.getAttribute('data-line')).toBe('8');
    expect(rows.map((r) => r.getAttribute('data-range'))).toEqual([
      'false',
      'false',
      'true',
      'true',
      'false',
    ]);
    expect(screen.getByTestId('finding-context-note')).toBeInTheDocument();
  });

  it('falls back to the evidence quote when there is no stored context', () => {
    render(<EvidenceCode finding={finding({ context: null })} />);
    expect(screen.getAllByTestId('code-row')).toHaveLength(1);
    expect(screen.getByTestId('code-row')).toHaveTextContent('src/pay.ts:10 — bpm-rule');
    expect(screen.queryByTestId('finding-context-note')).toBeNull();
  });
});
