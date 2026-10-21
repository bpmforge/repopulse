import { describe, expect, it } from 'vitest';
import type { ReportData } from '../types/index.js';
import {
  pdfFooterTemplate,
  pdfHeaderTemplate,
  reportScopeText,
  usesEndOfLifeData,
} from './render.js';

// W20-22 (UX_TODO ADM-66): every PDF page names its report, scope, date and
// workspace; the endoflife.date credit appears only where the data is used.

function data(over: Partial<ReportData['params']> = {}, sections: ReportData['sections'] = []) {
  return {
    params: {
      type: 'repo_health',
      workspaceId: '1',
      repoIds: ['4'],
      windowDays: 30,
      windowEnd: '2026-10-01T12:00:00.000Z',
      snapshotAt: '2026-10-01T12:00:00.000Z',
      weightsVersion: 'v1',
      catalogVersion: 'v1',
      workspaceName: 'Acme <Eng>',
      ...over,
    },
    sections,
    appendix: { definitions: [] },
    dataQuality: [
      { repoId: '4', repoName: 'acme/api', phase: 'live', partial: false, syncLagHours: 0 },
    ],
  } as ReportData;
}

describe('PDF header and footer', () => {
  it('puts title, scope and the pinned date in the header', () => {
    const header = pdfHeaderTemplate(data());
    expect(header).toContain('Repository Health · acme/api');
    expect(header).toContain('30-day window · generated 2026-10-01');
  });

  it('names the workspace, escaped, and leaves out the EOL credit when unused', () => {
    const footer = pdfFooterTemplate(data());
    expect(footer).toContain('Workspace: Acme &lt;Eng&gt;');
    expect(footer).not.toContain('endoflife');
    expect(footer).toContain('class="pageNumber"');
  });

  it('credits endoflife.date when the report quotes it', () => {
    const withEol = data({}, [
      {
        kind: 'summary',
        id: 'risk_sources',
        markdown: 'dates from [endoflife.date](https://endoflife.date)',
      },
    ] as ReportData['sections']);
    expect(usesEndOfLifeData(withEol)).toBe(true);
    expect(pdfFooterTemplate(withEol)).toContain('EOL dates from endoflife.date (MIT)');
  });

  it('says all repositories for an unscoped report', () => {
    expect(reportScopeText(data({ repoIds: [] }))).toBe('All repositories');
  });
});
