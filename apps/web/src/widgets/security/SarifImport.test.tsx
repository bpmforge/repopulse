import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SarifImport, importSummary, type SarifImportResult } from './SarifImport.js';

// W20-15 (UX_TODO X-09): SARIF import had an API and no screen.

const RESULT: SarifImportResult = {
  commit_sha: 'abc1234',
  results: 3,
  skipped: 0,
  tools: [
    {
      tool: 'CodeQL',
      tool_version: '2.19.0',
      results: 3,
      created: 2,
      updated: 1,
      reopened: 0,
      auto_resolved: 4,
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('SARIF import (W20-15, UX_TODO X-09)', () => {
  it('says per tool what was created and what was closed', () => {
    expect(importSummary(RESULT)).toEqual([
      'CodeQL 2.19.0: 2 new, 1 updated, 0 reopened, 4 closed',
    ]);
    expect(importSummary({ ...RESULT, tools: [], skipped: 2 })).toEqual([
      'No results in the file (2 skipped).',
    ]);
  });

  it('posts the file to the import route with the commit and sweep choice', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESULT), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SarifImport repoId="7" />
      </QueryClientProvider>,
    );
    const upload = screen.getByTestId('sarif-upload');
    expect(upload).toBeDisabled();

    const file = new File(['{"version":"2.1.0","runs":[]}'], 'codeql.sarif', {
      type: 'application/sarif+json',
    });
    fireEvent.change(screen.getByTestId('sarif-file'), { target: { files: [file] } });
    fireEvent.change(screen.getByTestId('sarif-sha'), { target: { value: 'not-a-sha' } });
    expect(upload).toBeDisabled();
    fireEvent.change(screen.getByTestId('sarif-sha'), { target: { value: 'abc1234' } });
    fireEvent.click(screen.getByTestId('sarif-sweep'));
    fireEvent.click(upload);

    await waitFor(() =>
      expect(screen.getByTestId('sarif-result')).toHaveTextContent('2 new, 1 updated'),
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/repos/7/external-findings/sarif?commit_sha=abc1234&sweep=false');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"version":"2.1.0","runs":[]}');
  });
});
