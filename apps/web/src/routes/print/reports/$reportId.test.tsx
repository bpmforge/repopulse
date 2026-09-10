import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from '../../__root.js';
import { cell, Route as printRoute } from './$reportId.js';
import { createQueryClient } from '../../../api/queryClient.js';

// Print layout (W17-26). The PDF is what a customer is handed, and the two ways
// it broke were a table row split across a page boundary and a long value in
// the last column pushed past the printable width and clipped. Neither is
// visible in a viewport test, so what is pinned is the CSS that prevents them
// on every row and cell, and that a cell never prints "[object Object]".

const LONG =
  'packages/analysis/src/gateway/providers/lmstudio/chunked-diff-retry-warmup-strategy.ts';

const DATA = {
  params: {
    type: 'code_health',
    windowDays: 30,
    snapshotAt: '2026-09-10T00:00:00.000Z',
    windowEnd: '2026-09-10T00:00:00.000Z',
  },
  sections: [
    { kind: 'summary', markdown: 'Scored 72 (B).' },
    {
      kind: 'table',
      id: 'hotspots',
      columns: ['File', 'Churn', 'Owners'],
      rows: [[LONG, 12, ['ann', 'bo']]],
    },
    {
      kind: 'score_breakdown',
      rows: [
        {
          subScore: 'ci',
          input: 'M1',
          rawValue: 0.5,
          normalized: 50,
          weight: 0.2,
          contribution: 10,
        },
      ],
    },
  ],
  appendix: {
    definitions: [{ id: 'M1', name: 'CI pass rate', formula: 'passed / total', unit: '%' }],
  },
  dataQuality: [
    { repoId: '1', repoName: 'acme/api', phase: 'live', partial: false, syncLagHours: 1 },
  ],
};

function renderPrint() {
  const queryClient = createQueryClient();
  const route = printRoute.update({
    id: '/print/reports/$reportId',
    path: '/print/reports/$reportId',
    getParentRoute: () => rootRoute,
  } as never) as never as typeof printRoute;
  const router = createRouter({
    routeTree: rootRoute.addChildren([route as never]),
    context: { queryClient } satisfies RouterContext,
    history: createMemoryHistory({ initialEntries: ['/print/reports/5'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  delete (window as unknown as { __REPORT_DATA?: unknown }).__REPORT_DATA;
  delete (window as unknown as { __REPORT_READY?: unknown }).__REPORT_READY;
});

describe('print route layout (W17-26)', () => {
  it('every table row avoids a page break and every cell wraps long values', async () => {
    (window as unknown as { __REPORT_DATA: unknown }).__REPORT_DATA = DATA;
    renderPrint();
    const report = await screen.findByTestId('print-report');

    const rows = [...report.querySelectorAll('tbody tr')];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const tr of rows) expect(tr.className).toContain('break-inside-avoid');

    const cells = [...report.querySelectorAll('tbody td')];
    expect(cells.length).toBeGreaterThan(0);
    for (const td of cells) expect(td.className).toContain('[overflow-wrap:anywhere]');

    // The long path is IN a cell, so wrapping is what stands between it and
    // the clipped last column.
    expect(cells.some((td) => td.textContent === LONG)).toBe(true);

    // A heading never sits alone at the foot of a page.
    for (const h2 of report.querySelectorAll('section h2')) {
      if (h2.closest('[data-testid="print-basis"]')) continue;
      expect(h2.className).toContain('break-after-avoid');
    }
    // The screen padding is dropped in print: the A4 body already has margins.
    expect(report.className).toContain('print:p-0');
  });

  it('names Code Health on the cover and signals ready once the content is in the DOM', async () => {
    (window as unknown as { __REPORT_DATA: unknown }).__REPORT_DATA = DATA;
    renderPrint();
    expect(await screen.findByTestId('print-title')).toHaveTextContent('Code Health');
    expect((window as unknown as { __REPORT_READY?: boolean }).__REPORT_READY).toBe(true);
  });

  it('a cell never prints [object Object]', () => {
    expect(cell(['ann', 'bo'])).toBe('ann, bo');
    expect(cell({ a: 1 })).toBe('{"a":1}');
    expect(cell(true)).toBe('yes');
    expect(cell(null)).toBe('—');
    expect(cell(1.2345)).toBe('1.23');
    (window as unknown as { __REPORT_DATA: unknown }).__REPORT_DATA = DATA;
    renderPrint();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });
});
