import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReportMarkdown } from './ReportMarkdown.js';

// W15-03 (F10). The review found the print report showing `**3 open findings**`
// and `` `act` `` with their syntax visible — in the page AND in the exported
// PDF built from that page. These tests are written against the exact strings
// the assemblers emit, so they fail on the defect rather than on a toy input.
describe('ReportMarkdown', () => {
  it('renders bold as <strong> and leaves no asterisks behind', () => {
    render(<ReportMarkdown markdown="**acme/infra** scored **38 (D)** over the last 30 days." />);
    const el = screen.getByTestId('report-markdown');

    expect(el).not.toHaveTextContent('**');
    expect(el).toHaveTextContent('acme/infra scored 38 (D) over the last 30 days.');
    expect(el.querySelectorAll('strong')).toHaveLength(2);
    expect(el.querySelectorAll('strong')[0]).toHaveTextContent('acme/infra');
    expect(el.querySelectorAll('strong')[1]).toHaveTextContent('38 (D)');
  });

  it('renders a code span as <code> and leaves no backticks behind', () => {
    render(
      <ReportMarkdown markdown="Bands are thresholds on a computed score: `act` is the top band." />,
    );
    const el = screen.getByTestId('report-markdown');

    expect(el.textContent).not.toContain('`');
    expect(el.querySelector('code')).toHaveTextContent('act');
  });

  it('splits on a blank line and collapses a soft wrap inside a paragraph', () => {
    render(<ReportMarkdown markdown={'First line\nsoft wrapped.\n\nSecond paragraph.'} />);
    const paras = screen.getByTestId('report-markdown').querySelectorAll('p');

    expect(paras).toHaveLength(2);
    // The single newline is source formatting, not a line break the reader
    // should see — it becomes one space.
    expect(paras[0]).toHaveTextContent('First line soft wrapped.');
    expect(paras[1]).toHaveTextContent('Second paragraph.');
  });

  it('leaves unmatched syntax as literal text rather than swallowing the rest', () => {
    // A lone ** must not consume the remainder of the paragraph and silently
    // delete content from a report someone is about to send to their VP.
    render(<ReportMarkdown markdown="2 ** 8 is 256 and the rest of this sentence survives." />);
    expect(screen.getByTestId('report-markdown')).toHaveTextContent(
      '2 ** 8 is 256 and the rest of this sentence survives.',
    );
  });

  it('escapes HTML rather than rendering it', () => {
    // Report text embeds repository and org names that came from a forge.
    render(<ReportMarkdown markdown="**<img src=x onerror=alert(1)>** in a repo name" />);
    const el = screen.getByTestId('report-markdown');

    expect(el.querySelector('img')).toBeNull();
    expect(el).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('renders nothing for an empty or whitespace-only section', () => {
    render(<ReportMarkdown markdown={'\n\n  \n'} />);
    expect(screen.getByTestId('report-markdown').querySelectorAll('p')).toHaveLength(0);
  });
});
