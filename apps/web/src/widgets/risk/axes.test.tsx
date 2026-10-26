import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { RiskAxesCard } from './RiskAxesCard.js';
import { RiskAxisStrip } from './RiskAxisStrip.js';

// The axis card and the header strip (W10-05, FR-INSIGHTS-3; W20-09).
//
// Collapsing the unmeasured axes is a change of weight, never of claim, so the
// assertions here are about both: the one summary line must exist AND every
// per-axis dash + reason must still be reachable behind the disclosure.
//
// W20-09 (UX_TODO DSH-11): an axis is a 0–100 score with the health badge's
// band word — never an A–E letter, and a screen reader never hears "grade".
//
// Note for anyone extending this file: jsdom keeps closed <details> content in
// the DOM, so a getByTestId inside the disclosure passes whether or not the
// user could ever open it. Assertions about reachability therefore go through
// an actual click on the summary.

let lastUrl = '';

function renderWith(payload: unknown, ui: React.ReactNode) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      lastUrl = String(input);
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const renderCard = (payload: unknown) => renderWith(payload, <RiskAxesCard repoId="1" />);
const renderStrip = (payload: unknown) => renderWith(payload, <RiskAxisStrip repoId="1" />);

afterEach(() => vi.unstubAllGlobals());

const axis = (over: Record<string, unknown> = {}) => ({
  axis: 'supplyChain',
  dimensions: ['dependency_health'],
  score: 74,
  band: 'watch',
  basis: '3 open findings, sub-score 74',
  top: [],
  ...over,
});

const unmeasured = (name: string, over: Record<string, unknown> = {}) =>
  axis({
    axis: name,
    score: null,
    band: null,
    basis: 'not measured — no scanner or analysis run has examined this scope yet',
    ...over,
  });

describe('risk axes card', () => {
  it('shows the score and its band word beside its basis — no letter (DSH-11)', async () => {
    renderCard({ axes: [axis()] });
    const score = await screen.findByTestId('axis-score-supplyChain');
    expect(score.textContent).toBe('74');
    expect(screen.getByTestId('axis-band-supplyChain')).toHaveTextContent('watch');
    expect(screen.getByTestId('axis-basis-supplyChain')).toHaveTextContent('sub-score 74');
    // The screen reader hears the number and the word, never "grade".
    expect(screen.getByLabelText('Supply Chain 74 of 100, watch')).toBeInTheDocument();
    expect(screen.queryByLabelText(/grade/)).toBeNull();
  });

  it('shows a DASH and a reason where no sub-score exists, never a score', async () => {
    renderCard({ axes: [unmeasured('supplyChain')] });
    const score = await screen.findByTestId('axis-score-supplyChain');
    // Exact text: a number smuggled in beside the dash is the failure.
    expect(score.textContent).toBe('—');
    expect(screen.getByTestId('axis-basis-supplyChain')).toHaveTextContent(/not measured/);
    expect(screen.getByLabelText(/Supply Chain not measured/)).toBeInTheDocument();
  });

  it('collapses unmeasured axes into one summary line plus the real next step', async () => {
    renderCard({
      axes: [unmeasured('security'), unmeasured('codeHealth'), unmeasured('supplyChain')],
      repos_in_scope: 3,
    });

    const summary = await screen.findByTestId('axis-unmeasured-summary');
    expect(summary).toHaveTextContent('Security, Code Health, Supply Chain');
    expect(summary).toHaveTextContent(/neither a good score nor a zero/);

    // DSH-72: repositories exist, nothing examined them — the step is a scan,
    // not "go to Admin → Connections".
    const next = screen.getByTestId('axis-unmeasured-next');
    expect(next).toHaveTextContent(/Run a scan/);
    expect(next).not.toHaveTextContent(/Connections/);

    const details = summary.closest('details');
    expect(details?.open).toBe(false);
    await userEvent.click(summary);
    expect(details?.open).toBe(true);
    for (const key of ['security', 'codeHealth', 'supplyChain']) {
      expect(screen.getByTestId(`axis-score-${key}`).textContent).toBe('—');
      expect(screen.getByTestId(`axis-${key}`).closest('details')).not.toBeNull();
    }
  });

  it('sends the admin to Connections only when no repository is tracked (DSH-72)', async () => {
    renderCard({ axes: [unmeasured('security')], repos_in_scope: 0 });
    expect(await screen.findByTestId('axis-unmeasured-next')).toHaveTextContent(
      /Settings → Connections/,
    );
  });

  it('treats a missing score as unmeasured rather than printing "undefined"', async () => {
    renderCard({ axes: [{ ...axis(), score: undefined, band: undefined }] });
    const summary = await screen.findByTestId('axis-unmeasured-summary');
    expect(summary).toHaveTextContent('Supply Chain');
    expect(screen.getByTestId('axis-score-supplyChain').textContent).toBe('—');
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('links each contributing finding to the finding (DSH-72)', async () => {
    renderCard({
      axes: [
        axis({
          axis: 'security',
          top: [{ finding_id: 42, title: 'SQL injection', severity: 5, effective_risk: 88 }],
        }),
      ],
    });
    const link = await screen.findByTestId('axis-finding-42');
    expect(link).toHaveAttribute('href', '/findings?finding=42');
    expect(link).toHaveTextContent('SQL injection');
  });

  it('keeps measured axes at full weight and quietly names only the unmeasured ones', async () => {
    renderCard({
      axes: [
        axis({ axis: 'security', score: 91, band: 'good', basis: '0 open findings, sub-score 91' }),
        unmeasured('codeHealth'),
      ],
    });
    const measuredRow = await screen.findByTestId('axis-security');
    expect(measuredRow).toHaveTextContent('91');
    expect(measuredRow).toHaveTextContent('healthy');
    expect(measuredRow.closest('details')).toBeNull();
    const summary = screen.getByTestId('axis-unmeasured-summary');
    expect(summary).toHaveTextContent('Code Health');
    expect(summary).not.toHaveTextContent('Security');
    expect(screen.queryByTestId('axis-unmeasured-next')).toBeNull();
  });

  it('asks for a view’s repositories when given a set (DSH-02)', async () => {
    renderWith({ axes: [axis()] }, <RiskAxesCard repos="3,4" />);
    await screen.findByTestId('axis-score-supplyChain');
    expect(lastUrl).toContain('repos=3%2C4');
  });
});

describe('risk axis strip', () => {
  it('shows measured scores inline with their word, and collapses the rest', async () => {
    renderStrip({
      axes: [
        axis({ axis: 'security', score: 91, band: 'good', basis: '0 open findings, sub-score 91' }),
        unmeasured('codeHealth'),
        unmeasured('supplyChain'),
      ],
    });

    const score = await screen.findByTestId('axis-strip-score-security');
    expect(score.textContent).toBe('91');
    expect(screen.getByLabelText('Security 91 of 100, healthy')).toBeInTheDocument();
    expect(screen.queryByLabelText(/grade/)).toBeNull();
    // W21-01: the name comes first and the score is out of 100, so "91" is not
    // read as a count of security findings.
    expect(score.closest('li')).toHaveTextContent(/^Security\s*91\/100\s*· healthy/);
    const summary = screen.getByTestId('axis-strip-unmeasured-summary');
    expect(summary).toHaveTextContent('2 not measured');
    expect(summary).toHaveTextContent('Code Health, Supply Chain');
  });

  it('keeps the dash, the reason and the "not measured" label reachable per axis', async () => {
    renderStrip({ axes: [unmeasured('codeHealth')] });
    const summary = await screen.findByTestId('axis-strip-unmeasured-summary');
    const details = summary.closest('details');
    await userEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(screen.getByTestId('axis-strip-score-codeHealth').textContent).toBe('—');
    expect(screen.getByTestId('axis-strip-basis-codeHealth')).toHaveTextContent(/not measured/);
    expect(screen.getByLabelText(/Code Health not measured/)).toBeInTheDocument();
  });

  it('never renders the unmeasured disclosure when all axes are measured', async () => {
    renderStrip({ axes: [axis()] });
    await screen.findByTestId('axis-strip-score-supplyChain');
    expect(screen.queryByTestId('axis-strip-unmeasured')).toBeNull();
  });
});
