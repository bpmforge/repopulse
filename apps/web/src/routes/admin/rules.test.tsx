import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { RuleWorkbench } from './rules.js';
import type { RuleRow } from '../../widgets/rules/contracts.js';

// Settings → Rules lifecycle buttons (W20-01, UX_TODO FND-69).
//
// The mutation used the template `/rules/{ruleId}/transition` with the id only
// in the body, so every press went to the literal `{ruleId}` URL and 404'd,
// and the page showed nothing. These tests check the URL the request hits.

const rule: RuleRow = {
  rule_id: 'bpm-new-rule',
  status: 'proposed',
  provenance: { source: 'drafted', license: 'internal' },
  shadow_started_at: null,
  evidence: { findings: 0, daysActive: 0, fpRate: null },
  promotion: { eligible: false, reasons: [] },
  demotion_candidate: false,
};

const requests: { url: string; init: RequestInit | undefined }[] = [];
let transitionAnswer: { status: number; body: unknown };

beforeEach(() => {
  requests.length = 0;
  transitionAnswer = { status: 200, body: { rule_id: rule.rule_id, status: 'candidate' } };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const answer = url.includes('/transition')
        ? transitionAnswer
        : url.endsWith('/rules')
          ? { status: 200, body: { items: [rule] } }
          : { status: 200, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RuleWorkbench />
    </QueryClientProvider>,
  );
}

describe('rule lifecycle buttons (W20-01)', () => {
  it('posts to the rule’s own URL with only the target state in the body', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId(`rule-advance-${rule.rule_id}`));
    await waitFor(() => {
      const post = requests.find((r) => r.init?.method === 'POST');
      expect(post?.url).toBe(`/api/v1/rules/${rule.rule_id}/transition`);
      expect(JSON.parse(String(post?.init?.body))).toEqual({ to: 'candidate' });
    });
    expect(requests.some((r) => r.url.includes('{ruleId}'))).toBe(false);
  });

  it('shows a refused transition on the row instead of doing nothing', async () => {
    transitionAnswer = {
      status: 400,
      body: { status: 400, title: 'Promotion gate not met', detail: 'too few findings' },
    };
    renderPage();
    fireEvent.click(await screen.findByTestId(`rule-advance-${rule.rule_id}`));
    expect((await screen.findByTestId(`rule-error-${rule.rule_id}`)).textContent).toMatch(
      /Promotion gate not met/,
    );
  });
});
