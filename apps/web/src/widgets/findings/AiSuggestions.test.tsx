import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSuggestions } from './AiSuggestions.js';
import type { AiSuggestion, FindingAi } from './aiContracts.js';

// W19-10. Everything the drawer shows from a model is labelled AI, carries its
// citation and route, and a person's answer is recorded WITHOUT moving the
// finding. "No review recorded" is its own sentence, never an empty success.

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: false,
  mutate: vi.fn(),
  isPending: false,
  calls: [] as unknown[],
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: state.data, isError: state.isError }),
  useApiMutation: (d: unknown) => {
    state.calls.push(d);
    return { mutate: state.mutate, isPending: state.isPending, error: null, variables: undefined };
  },
  queryKeyFor: () => [],
}));

const suggestion = (over: Partial<AiSuggestion> = {}): AiSuggestion => ({
  id: 5,
  verdict: 'likely_false_positive',
  confidence: 4,
  rationale: 'The value is a constant, never request input.',
  citations: [{ file: 'src/users.ts', line: 3, text: 'const q = "SELECT 1";' }],
  vex: null,
  patch: { status: 'not_attempted', reason: null, diff: null },
  model: 'qwen/qwen3.8-27b',
  checklist_version: 'triage.v1',
  route: { providerName: 'LM Studio', model: 'qwen/qwen3.8-27b', linkIndex: 0 },
  pass_id: 2,
  created_at: '2026-10-18T10:00:00Z',
  decision: null,
  decided_by: null,
  decided_at: null,
  ...over,
});

const respond = (r: FindingAi) => {
  state.data = r;
};

beforeEach(() => {
  state.data = undefined;
  state.isError = false;
  state.isPending = false;
  state.calls = [];
  state.mutate.mockReset();
});

describe('AiSuggestions', () => {
  it('says "not yet run" when nothing is recorded - not an empty success', () => {
    respond({ raised_by: null, suggestions: [] });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-not-run').textContent).toMatch(/Not yet run/);
    expect(screen.getByTestId('ai-not-run').textContent).toMatch(/says nothing about the finding/);
  });

  it('shows the verdict as AI, with confidence, model and route, and our copy of the cited line', () => {
    respond({ raised_by: null, suggestions: [suggestion()] });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getAllByTestId('ai-badge').length).toBeGreaterThan(0);
    expect(screen.getByTestId('ai-verdict').textContent).toMatch(/AI suggests this may be a false/);
    expect(screen.getByTestId('ai-route').textContent).toContain('LM Studio · qwen/qwen3.8-27b');
    expect(screen.getByTestId('ai-route').textContent).toMatch(/lead, not a result/);
    expect(screen.getByTestId('ai-citations').textContent).toContain('src/users.ts:3');
    expect(screen.getByTestId('ai-citations').textContent).toContain('const q = "SELECT 1";');
    expect(screen.getByText(/confidence 4\/5/)).toBeTruthy();
    expect(screen.getByTestId('ai-patch').textContent).toMatch(/No patch was proposed or proven/);
  });

  it('says so when a fallback link served the answer', () => {
    respond({
      raised_by: null,
      suggestions: [suggestion({ route: { providerName: 'Backup', model: 'm', linkIndex: 1 } })],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-route').textContent).toMatch(/fallback link/);
  });

  it('labels a specialist-raised finding as AI-raised, with its dimension', () => {
    respond({
      raised_by: {
        specialist: 'code_health',
        checklist_version: 'v1',
        model: 'm',
        route: { providerName: 'LM Studio', model: 'm', linkIndex: 0 },
        pass_id: 2,
      },
      suggestions: [],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-raised-by').textContent).toMatch(
      /raised by an AI specialist \(code health\)/,
    );
    expect(screen.getByTestId('ai-raised-by').textContent).toMatch(/A rule did not find it/);
    // It was raised by a model, so "not yet run" would be false.
    expect(screen.queryByTestId('ai-not-run')).toBeNull();
  });

  it('records an accept or a dismiss against the suggestion only', () => {
    respond({ raised_by: null, suggestions: [suggestion()] });
    render(<AiSuggestions findingId={7} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-decide').textContent).toMatch(/does not change the finding/);
    fireEvent.click(screen.getByTestId('ai-agree'));
    expect(state.mutate).toHaveBeenLastCalledWith({ decision: 'accepted' });
    fireEvent.click(screen.getByTestId('ai-disagree'));
    expect(state.mutate).toHaveBeenLastCalledWith({ decision: 'dismissed' });
    // The only endpoint it can post to is the suggestion's decide route.
    expect(state.calls[0]).toMatchObject({
      endpoint: '/findings/{id}/ai-verdicts/{verdictId}/decide',
      path: { id: 7, verdictId: 5 },
      method: 'POST',
    });
  });

  it('after accepting a false-positive suggestion, the finding is still open and dismissing is offered, not done', () => {
    const offer = vi.fn();
    respond({
      raised_by: null,
      suggestions: [
        suggestion({ decision: 'accepted', decided_by: 'ada', decided_at: '2026-10-18T11:00:00Z' }),
      ],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={offer} />);
    expect(screen.getByTestId('ai-decided').textContent).toMatch(
      /Suggestion accepted by ada on 2026-10-18/,
    );
    expect(screen.getByTestId('ai-offer-dismiss').textContent).toMatch(
      /does not dismiss the finding: it is still open/,
    );
    expect(state.mutate).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ai-prefill-dismiss'));
    expect(offer).toHaveBeenCalledTimes(1);
    // Prefilling is a callback into the drawer's form; nothing was posted.
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('offers no dismiss shortcut for an accepted "real" verdict, and shows the proposed VEX as a proposal', () => {
    respond({
      raised_by: null,
      suggestions: [
        suggestion({
          verdict: 'real',
          decision: 'accepted',
          vex: { justification: 'vulnerable_code_not_in_execute_path', statement: 'dead code' },
        }),
      ],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.queryByTestId('ai-offer-dismiss')).toBeNull();
    expect(screen.getByTestId('ai-vex').textContent).toMatch(
      /Nothing is recorded as VEX until a person/,
    );
  });

  it('says a load failure is not news about the finding', () => {
    state.isError = true;
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-unavailable').textContent).toMatch(
      /says nothing about the finding/,
    );
  });

  it('treats a body of another shape as nothing recorded rather than crashing', () => {
    state.data = {};
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-not-run')).toBeTruthy();
  });

  it('says what the pass reviewed next to a suggestion, and next to an AI-raised finding', () => {
    respond({
      raised_by: {
        specialist: 'security',
        checklist_version: 'v1',
        model: 'm',
        route: { providerName: 'LM Studio', model: 'm', linkIndex: 0 },
        pass_id: 2,
        pass: {
          id: 2,
          mode: 'pull_request',
          pr_number: 12,
          base_ref: 'main',
          head_ref: 'abcdef0123',
          commit_sha: 'abcdef0123',
          paths: [],
        },
      },
      suggestions: [
        suggestion({
          pass: {
            id: 3,
            mode: 'commit_range',
            pr_number: null,
            base_ref: 'aaaaaaa1234',
            head_ref: 'bbbbbbb5678',
            commit_sha: 'bbbbbbb5678',
            paths: [],
          },
        }),
      ],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-raised-by').textContent).toMatch(
      /in a pass over the diff of pull request #12 \(base main, head abcdef01/,
    );
    expect(screen.getByTestId('ai-route').textContent).toMatch(
      /From a pass over the commits aaaaaaa1\.\.bbbbbbb5/,
    );
  });

  it('does not double the full stop when the proposed VEX statement already ends with one', () => {
    respond({
      raised_by: null,
      suggestions: [
        suggestion({
          vex: {
            justification: 'inline_mitigations_already_exist',
            statement: 'Values are bound.',
          },
        }),
      ],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-vex').textContent).toMatch(
      /Values are bound\. Nothing is recorded/,
    );
    expect(screen.getByTestId('ai-vex').textContent).not.toMatch(/\.\./);
  });
});
