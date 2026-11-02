import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { RuleWorkbench, displayLicence } from './rules.js';
import { RULE_TRANSITIONS, type RuleRow } from '../../widgets/rules/contracts.js';

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
let rows: RuleRow[];

beforeEach(() => {
  requests.length = 0;
  rows = [rule];
  transitionAnswer = { status: 200, body: { rule_id: rule.rule_id, status: 'candidate' } };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const answer = url.includes('/transition')
        ? transitionAnswer
        : url.endsWith('/rules')
          ? { status: 200, body: { items: rows } }
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
    fireEvent.click(await screen.findByTestId(`rule-move-candidate-${rule.rule_id}`));
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
    fireEvent.click(await screen.findByTestId(`rule-move-candidate-${rule.rule_id}`));
    expect((await screen.findByTestId(`rule-error-${rule.rule_id}`)).textContent).toMatch(
      /Promotion gate not met/,
    );
  });
});

// W20-03 (UX_TODO FND-15, FND-16): confirm before Promote and every destructive
// step, say what happened, draw destructive steps neutral, and offer every move
// the lifecycle allows rather than one forward step.
describe('rule workbench moves (W20-03)', () => {
  const at = (status: RuleRow['status'], over: Partial<RuleRow> = {}): RuleRow => ({
    ...rule,
    rule_id: `r-${status}`,
    status,
    ...over,
  });
  const posts = () => requests.filter((r) => r.init?.method === 'POST');

  it.each([
    ['proposed', ['Accept to shadow', 'Reject']],
    ['candidate', ['Promote to active', 'Retire']],
    ['active', ['Deprecate']],
    ['deprecated', ['Return to shadow']],
  ] as const)('from %s, offers %j', async (status, labels) => {
    rows = [at(status)];
    renderPage();
    const row = await screen.findByTestId(`rule-row-r-${status}`);
    const offered = [...row.querySelectorAll('[data-testid^="rule-move-"]')].map(
      (b) => b.textContent,
    );
    expect(offered).toEqual(labels);
  });

  it('Reject asks first, Cancel sends nothing, and yes sends it and says so', async () => {
    rows = [at('proposed')];
    transitionAnswer = { status: 200, body: { rule_id: 'r-proposed', status: 'deprecated' } };
    renderPage();
    const reject = await screen.findByTestId('rule-move-deprecated-r-proposed');
    // Neutral, not the accent the forward step wears.
    expect(reject.className).not.toMatch(/border-accent/);
    expect(screen.getByTestId('rule-move-candidate-r-proposed').className).toMatch(/border-accent/);

    fireEvent.click(reject);
    expect(screen.getByTestId('rule-confirm-r-proposed')).toHaveTextContent(/Reject this proposal/);
    fireEvent.click(screen.getByTestId('rule-confirm-no-r-proposed'));
    expect(posts()).toHaveLength(0);

    fireEvent.click(reject);
    fireEvent.click(screen.getByTestId('rule-confirm-yes-r-proposed'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]!.init?.body))).toEqual({ to: 'deprecated' });
    expect(await screen.findByTestId('rule-status-message')).toHaveTextContent(
      'Rejected. The rule will not run.',
    );
  });

  it('Promote asks first too', async () => {
    rows = [at('candidate', { promotion: { eligible: true, reasons: [] } })];
    renderPage();
    fireEvent.click(await screen.findByTestId('rule-move-active-r-candidate'));
    expect(posts()).toHaveLength(0);
    expect(screen.getByTestId('rule-confirm-r-candidate')).toHaveTextContent(/Promote to active\?/);
  });

  it('a demotion candidate has its demotion action beside the flag', async () => {
    rows = [at('active', { demotion_candidate: true })];
    renderPage();
    fireEvent.click(await screen.findByTestId('rule-demote-action-r-active'));
    expect(screen.getByTestId('rule-confirm-r-active')).toHaveTextContent(
      /Deprecate this active rule/,
    );
  });

  it('the web table mirrors ALLOWED in packages/security/src/rules/lifecycle.ts', () => {
    const candidates = [
      path.resolve(process.cwd(), '../../packages/security/src/rules/lifecycle.ts'),
      path.resolve(process.cwd(), 'packages/security/src/rules/lifecycle.ts'),
    ];
    const file = candidates.find((c) => existsSync(c));
    if (!file) throw new Error(`lifecycle.ts not found; looked in: ${candidates.join(', ')}`);
    const block = /const ALLOWED[^=]*=\s*\{([\s\S]*?)\n\};/.exec(readFileSync(file, 'utf8'))?.[1];
    const parsed: Record<string, string[]> = {};
    for (const m of (block ?? '').matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
      parsed[m[1]!] = [...m[2]!.matchAll(/'(\w+)'/g)].map((x) => x[1]!);
    }
    expect(Object.keys(parsed).length).toBe(4);
    expect(parsed).toEqual(RULE_TRANSITIONS);
  });
});

// W20-08 (UX_TODO FND-65): nothing could put a rule into the registry. The
// workbench now has a Propose form that posts a proposed rule to /rules.
describe('propose a rule (W20-08)', () => {
  it('opens the form, names what is missing, and posts a proposed rule', async () => {
    rows = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('propose-rule-open'));
    const submit = screen.getByTestId('propose-rule-submit');
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('propose-rule-problems')).toHaveTextContent(
      /Name at least one language/,
    );
    fireEvent.change(screen.getByTestId('propose-rule-id'), {
      target: { value: 'perf.n-plus-one' },
    });
    fireEvent.change(screen.getByTestId('propose-rule-languages'), {
      target: { value: 'typescript' },
    });
    fireEvent.change(screen.getByTestId('propose-rule-checklist'), {
      target: { value: 'Is a query issued inside a loop?' },
    });
    fireEvent.change(screen.getByTestId('propose-rule-trigger'), {
      target: { value: 'for (const x of xs) await db.q(x)' },
    });
    fireEvent.change(screen.getByTestId('propose-rule-clean'), {
      target: { value: 'await db.q(xs)' },
    });
    fireEvent.click(submit);
    await waitFor(() => {
      const post = requests.find((r) => r.init?.method === 'POST');
      expect(post?.url).toBe('/api/v1/rules');
      expect(JSON.parse(String(post?.init?.body))).toMatchObject({
        id: 'perf.n-plus-one',
        status: 'proposed',
        languages: ['typescript'],
      });
    });
  });
});

describe('rule licence shown on the workbench (W22-13)', () => {
  it('shows rules stored before the Apache-2.0 relicensing as Apache-2.0', () => {
    expect(displayLicence('UNLICENSED-REPOPULSE')).toBe('Apache-2.0');
    expect(displayLicence('MIT')).toBe('MIT');
  });
});
