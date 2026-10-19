import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import { autoCloseNote, type Finding } from './contracts.js';
import { draftFrom, draftProblems, ruleBody } from '../rules/ProposeRuleForm.js';

// W20-08: the finding panel's dismiss gate (FND-66), auto-close note (FND-58),
// "Why this applies" (FND-57), VEX form (FND-05) and rule proposal (FND-65).

const state = vi.hoisted(() => ({
  role: 'member' as string,
  calls: [] as { endpoint: string; body: unknown }[],
}));

vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: (d: { endpoint: string }) => ({
    mutate: vi.fn((body: unknown) => state.calls.push({ endpoint: d.endpoint, body })),
    isPending: false,
    isSuccess: false,
    variables: undefined,
    error: null,
  }),
  useApiQuery: (d: { endpoint: string }) => ({
    data: d.endpoint === '/me/context' ? { role: state.role } : { items: [] },
  }),
  queryKeyFor: () => [],
}));

// AiSuggestions' "start an AI review pass" link (W20-11) needs no router here.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 7,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'security',
    severity: 3,
    confidence: 4,
    title: 'Unvalidated redirect',
    file: 'src/auth.ts',
    line_range: [10, 12],
    evidence: 'res.redirect(req.query.next)',
    recommendation: 'Allow-list the destination.',
    status: 'open',
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
    forge: null,
    ...over,
  };
}

const renderPanel = (f: Finding) =>
  render(<FindingDetail finding={f} onClose={vi.fn()} invalidate={[]} />);

beforeEach(() => {
  state.role = 'member';
  state.calls = [];
});

describe('dismiss gate (FND-66)', () => {
  it('needs a note of ten characters to dismiss, but not to confirm', () => {
    renderPanel(finding());
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'harmless' } });
    expect(screen.getByTestId('finding-dismiss')).toBeDisabled();
    expect(screen.getByTestId('finding-confirm')).toBeEnabled();
    fireEvent.change(screen.getByTestId('finding-note'), {
      target: { value: 'harmless test code' },
    });
    expect(screen.getByTestId('finding-dismiss')).toBeEnabled();
  });

  it('locks Dismiss for a member when the API says an admin is needed, and says so', () => {
    renderPanel(finding({ severity: 5, dismiss_requires_admin: true }));
    fireEvent.change(screen.getByTestId('finding-note'), {
      target: { value: 'harmless test code' },
    });
    expect(screen.getByTestId('finding-dismiss')).toBeDisabled();
    expect(screen.getByTestId('finding-dismiss-rule')).toHaveTextContent(/admins only/);
  });

  it('an admin may dismiss the same finding', () => {
    state.role = 'admin';
    renderPanel(finding({ severity: 5, dismiss_requires_admin: true }));
    fireEvent.change(screen.getByTestId('finding-note'), {
      target: { value: 'harmless test code' },
    });
    expect(screen.getByTestId('finding-dismiss')).toBeEnabled();
  });
});

describe('auto-close note and Mark fixed (FND-58)', () => {
  it('offers Mark fixed from open and says whether a re-scan closes it', () => {
    renderPanel(finding({ scanner_key: 'semgrep', rule_id: 'bpm.redirect' }));
    expect(screen.getByTestId('finding-resolve')).toBeInTheDocument();
    expect(screen.getByTestId('finding-auto-close')).toHaveTextContent(/Closes on its own/);
  });

  it('a model judgment never closes on its own', () => {
    expect(autoCloseNote({ scanner_key: 'logging_hygiene', rule_id: 'logging.judgment' })).toMatch(
      /Does not close on its own/,
    );
    expect(autoCloseNote({ scanner_key: null, rule_id: null })).toMatch(/Does not close/);
  });
});

describe('dependency findings (FND-57, FND-05)', () => {
  const dep = finding({
    dimension: 'dependency',
    cve_id: 'CVE-2026-1',
    rule_id: 'CVE-2026-1',
    rationale: 'lodash 4.17.20 is in the production tree and merge() is called.',
    dependency: {
      reachability: 'symbol_reachable',
      usage: 'calls merge',
      usage_evidence: [],
      call_sites: [{ file: 'src/a.ts', line: 3, symbol: 'merge' }],
      scope: { kind: 'prod', depth: 1 },
      epss: 0.42,
      aliases: ['GHSA-xxxx'],
    },
  });

  it('shows why it applies: rationale, reachability and call sites', () => {
    renderPanel(dep);
    expect(screen.getByTestId('finding-rationale')).toHaveTextContent('merge() is called');
    expect(screen.getByTestId('dependency-reachability')).toHaveTextContent('symbol reachable');
    expect(screen.getByTestId('dependency-call-sites')).toHaveTextContent('src/a.ts');
  });

  it('records a VEX statement only with a justification when not affected', () => {
    renderPanel(dep);
    fireEvent.click(screen.getByTestId('vex-open'));
    expect(screen.getByTestId('vex-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('vex-justification'), {
      target: { value: 'vulnerable_code_not_in_execute_path' },
    });
    fireEvent.click(screen.getByTestId('vex-submit'));
    expect(state.calls.find((c) => c.endpoint === '/findings/{id}/vex')?.body).toEqual({
      status: 'not_affected',
      justification: 'vulnerable_code_not_in_execute_path',
    });
  });

  it('offers no VEX form on a finding that is not a dependency', () => {
    renderPanel(finding());
    expect(screen.queryByTestId('vex-open')).toBeNull();
  });
});

describe('propose a rule (FND-65)', () => {
  it('is offered to an admin only, seeded from the finding', () => {
    renderPanel(finding());
    expect(screen.queryByTestId('finding-propose-rule')).toBeNull();
    state.role = 'admin';
    renderPanel(finding({ dimension: 'performance', file: 'src/q.ts', rule_id: 'perf.n+1' }));
    fireEvent.click(screen.getByTestId('finding-propose-rule'));
    expect(screen.getByTestId('propose-rule-id')).toHaveValue('perf.perf-n-1');
  });

  it('names what is missing, and posts a proposed rule with provenance', () => {
    const d = draftFrom({
      id: 9,
      title: 'Query in a loop',
      dimension: 'performance',
      severity: 3,
      file: 'src/q.ts',
      evidence: 'for (x of xs) await db.q(x)',
    });
    expect(draftProblems(d)).toEqual(['Add code the rule must NOT fire on.']);
    const body = ruleBody({ ...d, clean: 'await db.q(xs)' });
    expect(body).toMatchObject({
      id: 'perf.query-in-a-loop',
      status: 'proposed',
      languages: ['typescript'],
      provenance: { source: 'field_lesson:finding/9' },
      fixtures: { trigger: ['for (x of xs) await db.q(x)'], clean: ['await db.q(xs)'] },
    });
    expect(draftProblems(draftFrom())).toContain('Name at least one language.');
  });
});
