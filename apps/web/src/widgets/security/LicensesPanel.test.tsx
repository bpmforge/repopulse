import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { LicensesPanel } from './LicensesPanel.js';

// W20-08 (UX_TODO FND-18): the Security tab lists the license findings still
// to fix and links the policy that raised them.

const urls: string[] = [];
let policyItems: unknown[];

beforeEach(() => {
  urls.length = 0;
  policyItems = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      urls.push(url);
      const items = url.includes('rule_id=license.policy') ? policyItems : [];
      return Promise.resolve(
        new Response(JSON.stringify({ items, next_cursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPanel() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LicensesPanel repoId="7" />
    </QueryClientProvider>,
  );
}

describe('LicensesPanel (W20-08)', () => {
  it('asks for the active license findings of this repository only', async () => {
    renderPanel();
    await screen.findByTestId('licenses-empty');
    expect(urls.some((u) => /repo_id=7/.test(u) && /status=active/.test(u))).toBe(true);
    expect(urls.some((u) => u.includes('rule_id=license.unknown'))).toBe(true);
    expect(screen.getByTestId('licenses-policy-link')).toHaveAttribute('href', '/admin/settings');
  });

  it('links each finding to the findings explorer', async () => {
    policyItems = [{ id: 41, severity: 3, title: 'left-pad is AGPL-3.0' }];
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('license-finding-41')).toHaveAttribute(
        'href',
        '/findings?finding=41&repos=7',
      ),
    );
    expect(screen.getByText('Flagged by policy')).toBeInTheDocument();
  });
});
