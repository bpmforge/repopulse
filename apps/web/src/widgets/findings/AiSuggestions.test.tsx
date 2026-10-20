import type { ReactNode } from 'react';
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

// The "start an AI review pass" link (W20-11) renders as a plain anchor.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    hash,
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    hash?: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={`${to.replace('$repoId', params?.repoId ?? '')}${
        search ? `?${new URLSearchParams(search).toString()}` : ''
      }${hash ? `#${hash}` : ''}`}
      {...rest}
    >
      {children}
    </a>
  ),
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
      /raised by an AI specialist \(Code health\)/,
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

  it('sends an optional why note with the answer and shows it afterwards (AI-40)', () => {
    respond({ raised_by: null, suggestions: [suggestion()] });
    const { unmount } = render(<AiSuggestions findingId={7} onOfferDismiss={() => {}} />);
    fireEvent.change(screen.getByTestId('ai-decision-note'), {
      target: { value: '  input is validated above  ' },
    });
    fireEvent.click(screen.getByTestId('ai-disagree'));
    expect(state.mutate).toHaveBeenLastCalledWith({
      decision: 'dismissed',
      note: 'input is validated above',
    });
    unmount();
    respond({
      raised_by: null,
      suggestions: [
        suggestion({
          decision: 'dismissed',
          decided_by: 'ada',
          decided_at: '2026-10-18T11:00:00Z',
          decision_note: 'input is validated above',
        }),
      ],
    });
    render(<AiSuggestions findingId={7} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-decision-note-shown')).toHaveTextContent(
      'Why: input is validated above',
    );
  });

  it('says it is loading rather than rendering nothing (AI-51)', () => {
    state.data = undefined;
    render(<AiSuggestions findingId={7} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-loading')).toHaveTextContent('Loading AI review');
  });

  it('a citation in the finding file jumps to the evidence (AI-52)', () => {
    respond({
      raised_by: null,
      suggestions: [suggestion({ citations: [{ file: 'src/a.ts', line: 3, text: 'x' }] })],
    });
    const target = document.createElement('div');
    target.id = 'finding-evidence';
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    document.body.appendChild(target);
    render(
      <AiSuggestions
        findingId={7}
        onOfferDismiss={() => {}}
        finding={{
          repoId: 1,
          file: 'src/a.ts',
          line: 3,
          status: 'open',
          experimental: false,
          scannerKey: 's',
          ruleId: 'r',
          hasContext: true,
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-citation-jump'));
    expect(scroll).toHaveBeenCalled();
    target.remove();
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
      /Answered “Agree: likely a false positive” by ada on 2026-10-18/,
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
  // W20-11 (UX_TODO AI-39): the buttons name what is agreed with.
  it('names the answer buttons after the verdict', () => {
    respond({ raised_by: null, suggestions: [suggestion({ verdict: 'real' })] });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-agree')).toHaveTextContent('Agree it’s real');
    expect(screen.getByTestId('ai-disagree')).toHaveTextContent('Disagree: not real');
  });

  // W20-11 (UX_TODO AI-42): whose confidence it is, and what the scale means.
  it('says the confidence is the model’s own rating', () => {
    respond({ raised_by: null, suggestions: [suggestion()] });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-confidence')).toHaveTextContent('AI confidence 4/5');
    expect(screen.getByTestId('ai-confidence-scale')).toHaveTextContent(/not a measured accuracy/);
  });

  // W20-11 (UX_TODO AI-40, partial): a mis-click can be taken back for a while.
  it('offers to change an answer while the server allows it, and sends an undo', () => {
    respond({
      raised_by: null,
      suggestions: [
        suggestion({
          decision: 'dismissed',
          decided_by: 'ada',
          decided_at: '2026-10-18T11:00:00Z',
          can_undo: true,
        }),
      ],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    fireEvent.click(screen.getByTestId('ai-undo'));
    expect(state.mutate).toHaveBeenCalledWith({ undo: true });
  });

  it('offers no undo once the server says it is too late', () => {
    respond({
      raised_by: null,
      suggestions: [suggestion({ decision: 'dismissed', decided_by: 'ada', can_undo: false })],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.queryByTestId('ai-undo')).toBeNull();
  });

  // W20-11 (UX_TODO AI-41): agreeing it is real points at Confirm, never confirms.
  it('after agreeing a finding is real, offers Confirm without doing it', () => {
    const confirm = vi.fn();
    respond({
      raised_by: null,
      suggestions: [suggestion({ verdict: 'real', decision: 'accepted', decided_by: 'ada' })],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} onOfferConfirm={confirm} />);
    expect(screen.getByTestId('ai-offer-confirm')).toHaveTextContent(
      /does not confirm the finding/,
    );
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ai-prefill-confirm'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  // W20-11 (UX_TODO AI-43, partial): the OpenVEX value in words.
  it('puts the proposed VEX justification in words, keeping the raw value', () => {
    respond({
      raised_by: null,
      suggestions: [
        suggestion({
          vex: { justification: 'vulnerable_code_not_in_execute_path', statement: 'Dead code.' },
        }),
      ],
    });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} />);
    expect(screen.getByTestId('ai-vex')).toHaveTextContent(
      'the vulnerable code is never executed (vulnerable_code_not_in_execute_path)',
    );
  });

  const ctx = {
    repoId: 3,
    file: 'src/users.ts',
    line: 3,
    status: 'open',
    scannerKey: 'semgrep',
    ruleId: 'sql',
    hasContext: true,
    experimental: false,
  };

  // W20-11 (UX_TODO AI-44): "not yet run" for a finding a pass can never triage.
  it('says when an AI pass would not triage this finding, and why', () => {
    respond({ raised_by: null, suggestions: [] });
    render(
      <AiSuggestions
        findingId={1}
        onOfferDismiss={() => {}}
        finding={{ ...ctx, file: null, line: null }}
      />,
    );
    expect(screen.getByTestId('ai-not-eligible')).toHaveTextContent(/not tied to a line of a file/);
    expect(screen.queryByTestId('ai-not-run')).toBeNull();
  });

  // W20-11 (UX_TODO AI-83): "not yet run" links to where a pass is started.
  it('links "not yet run" to the AI review pass, with the file filled in', () => {
    respond({ raised_by: null, suggestions: [] });
    render(<AiSuggestions findingId={1} onOfferDismiss={() => {}} finding={ctx} />);
    expect(screen.getByTestId('ai-start-pass-link').getAttribute('href')).toBe(
      '/repos/3/security?ai_path=src%2Fusers.ts#ai-review-pass',
    );
  });
});
