import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import { TriageQueue } from './TriageQueue.js';
import type { Finding } from './contracts.js';

// W17-22 acceptance 3: malicious evidence text is rendered as text.
//
// Evidence is a verbatim quote from somebody else's diff (W6-02). A diff can
// contain anything, including markup written to run when a reviewer opens the
// finding. It must land on screen as the characters it is, never as elements.

const mutate = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: () => ({ mutate, isPending: false }),
  useApiQuery: () => ({ data: { items: [] } }),
  queryKeyFor: () => [],
}));

const PAYLOAD =
  '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><a href="javascript:alert(1)">x</a>';

function hostile(): Finding {
  return {
    id: 5,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'security',
    severity: 4,
    confidence: 4,
    title: `<b>bold</b> ${PAYLOAD}`,
    file: 'src/a.ts',
    line_range: [10, 12],
    evidence: PAYLOAD,
    recommendation: `Use ${PAYLOAD}`,
    status: 'open',
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
    forge: null,
  } as unknown as Finding;
}

function assertInert(container: HTMLElement) {
  expect(container.querySelector('img, script, a[href^="javascript"], b')).toBeNull();
  expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  // The characters themselves are still there — a reviewer needs to SEE the
  // payload to judge the finding; it just must not run.
  expect(container.textContent).toContain('<img src=x onerror=');
  expect(container.textContent).toContain('<script>');
}

describe('malicious evidence is rendered as text (W17-22)', () => {
  it('in the detail panel: evidence, recommendation and title', () => {
    const { container } = render(
      <FindingDetail finding={hostile()} onClose={vi.fn()} invalidate={[]} />,
    );
    assertInert(container);
  });

  it('in the triage queue', () => {
    const { container } = render(
      <TriageQueue findings={[hostile()]} onExit={vi.fn()} invalidate={[]} />,
    );
    assertInert(container);
  });

  it('no findings screen uses dangerouslySetInnerHTML', () => {
    let dir = resolve(process.cwd());
    while (!existsSync(join(dir, 'plan.json'))) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error('repo root not found');
      dir = parent;
    }
    for (const rel of ['apps/web/src/widgets/findings', 'apps/web/src/routes/findings']) {
      for (const file of readdirSync(join(dir, rel))) {
        if (!/\.tsx?$/.test(file) || file.includes('.test.')) continue;
        expect(readFileSync(join(dir, rel, file), 'utf8'), `${rel}/${file}`).not.toContain(
          'dangerouslySetInnerHTML',
        );
      }
    }
  });
});

describe('the detail panel closes on Escape (W17-22)', () => {
  it('calls onClose when Escape is pressed inside it', () => {
    const onClose = vi.fn();
    render(<FindingDetail finding={hostile()} onClose={onClose} invalidate={[]} />);
    fireEvent.keyDown(screen.getByTestId('finding-note'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// W18-29. A link opens the panel with no list around it, so the panel itself
// must say the finding comes from a rule still in shadow.
describe('a shadow finding is labelled in the panel (W18-29)', () => {
  it('shows the shadow note and the rule id', () => {
    const f = {
      ...hostile(),
      title: 'Phantom reference',
      evidence: 'e',
      recommendation: 'r',
      rule_id: 'slop.phantom_ref',
      experimental: true,
    } as Finding;
    render(<FindingDetail finding={f} onClose={vi.fn()} invalidate={[]} />);
    expect(screen.getByTestId('finding-shadow-note')).toHaveTextContent('rule still in shadow');
    expect(screen.getByTestId('finding-rule')).toHaveTextContent('rule slop.phantom_ref');
  });

  it('an active finding carries no shadow note', () => {
    render(<FindingDetail finding={hostile()} onClose={vi.fn()} invalidate={[]} />);
    expect(screen.queryByTestId('finding-shadow-note')).toBeNull();
  });
});

// W21-01 (tour item 12): a model-raised finding confirmed by the second-model
// verify pass (W6-05) said nothing about it in the panel — "verified by
// <model>" reads the AI triage of RULE findings, which this pass is not — while
// the list beside it said "verified by a second model".
describe('the verify pass outcome is in the panel (W21-01)', () => {
  it('says verified, and says nothing for an unverified finding', () => {
    const { rerender } = render(
      <FindingDetail
        finding={{ ...hostile(), verify_status: 'confirmed' } as Finding}
        onClose={vi.fn()}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('finding-verify-status')).toHaveTextContent(
      /confirmed on AI review/i,
    );
    rerender(<FindingDetail finding={hostile()} onClose={vi.fn()} invalidate={[]} />);
    expect(screen.queryByTestId('finding-verify-status')).toBeNull();
    // Once the pass names its model (W21-03), "verified by <model>" says it.
    rerender(
      <FindingDetail
        finding={
          {
            ...hostile(),
            verify_status: 'confirmed',
            verified_by: { model: 'm-2', connection: null, verdict: 'confirmed', at: null },
          } as Finding
        }
        onClose={vi.fn()}
        invalidate={[]}
      />,
    );
    expect(screen.queryByTestId('finding-verify-status')).toBeNull();
    expect(screen.getByTestId('finding-verified-by')).toHaveTextContent(/m-2/);
  });

  // W22-03 (2026-10-29): a performance hit judged real on a small, bounded
  // input stays confirmed, and the panel says it is small.
  it('says "real, but small input" when the judge found the impact negligible', () => {
    render(
      <FindingDetail
        finding={
          {
            ...hostile(),
            verify_status: 'confirmed',
            verified_by: {
              model: 'm-3',
              connection: null,
              verdict: 'real',
              at: null,
              impact: 'negligible',
            },
          } as Finding
        }
        onClose={vi.fn()}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('finding-verified-by')).toHaveTextContent(
      /judged real, but small input/,
    );
  });
});
