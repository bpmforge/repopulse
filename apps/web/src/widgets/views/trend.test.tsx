import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { getWidget } from '../../components/widget/WidgetRegistry.js';
import type { Widget } from '../../components/widget/types.js';
import { ViewEditor } from '../../views/ViewEditor.js';
import { trendMetric } from './register.js';

// W20-05 (UX_TODO DSH-60). The Executive rollup's trend card was titled "M5
// trend" with no unit, and the editor could not pick another metric.

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            points: [
              { computed_at: '2026-09-01T00:00:00Z', value: 0.5 },
              { computed_at: '2026-10-01T00:00:00Z', value: 0.8 },
            ],
            basis_label: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const trend = (options?: Record<string, unknown>): Widget => ({
  id: 't',
  type: 'trend',
  layout: { x: 0, y: 0, w: 12, h: 2 },
  ...(options ? { options } : {}),
});

describe('trend widget (DSH-60)', () => {
  it('names the metric and its unit, not the raw id', async () => {
    const Trend = getWidget('trend')!.component;
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Trend widget={trend({ window: '90d' })} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Review coverage trend')).toBeInTheDocument();
    expect(screen.queryByText('M5 trend')).toBeNull();
    // The window the view handed it reaches the query (DSH-02).
    expect(urls[0]).toContain('window=90d');
    expect(trendMetric('M9')).toEqual({ key: 'M9', label: 'CI pass rate', unit: '%' });
    expect(trendMetric('M99').label).toBe('M99');
  });

  it('the editor picks the metric and the window per widget', () => {
    const onChange = vi.fn();
    render(<ViewEditor widgets={[trend()]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('metric-t'), { target: { value: 'M4' } });
    expect(onChange).toHaveBeenLastCalledWith([trend({ metric_key: 'M4' })]);
  });

  it('the editor picks one repository, or the whole organization', () => {
    const onChange = vi.fn();
    render(
      <ViewEditor
        widgets={[trend()]}
        onChange={onChange}
        repos={[{ id: 7, org: 'acme', name: 'web' }]}
      />,
    );
    fireEvent.change(screen.getByTestId('repo-t'), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith([trend({ repo_id: '7' })]);
  });

  it("charts one repository's series when the widget names one", async () => {
    const Trend = getWidget('trend')!.component;
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Trend widget={trend({ repo_id: '7', metric_key: 'M9' })} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('CI pass rate trend')).toBeInTheDocument();
    expect(urls[0]).toContain('repo_id=7');
  });

  it("'View's window' removes the override rather than storing today's window", () => {
    const onChange = vi.fn();
    render(<ViewEditor widgets={[trend({ window: '365d' })]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('window-t'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith([trend()]);
  });
});
