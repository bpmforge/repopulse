import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { RiskAxesCard } from './RiskAxesCard.js';
import { RiskAxisStrip } from './RiskAxisStrip.js';

// The axis card and the header strip (W10-05, FR-INSIGHTS-3).
//
// Collapsing the unmeasured axes is a change of weight, never of claim, so the
// assertions here are about both: the one summary line must exist AND every
// per-axis dash + reason must still be reachable behind the disclosure.
//
// Note for anyone extending this file: jsdom keeps closed <details> content in
// the DOM, so a getByTestId inside the disclosure passes whether or not the
// user could ever open it. Assertions about reachability therefore go through
// an actual click on the summary.

function renderWith(payload: unknown, ui: React.ReactNode) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
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
  letter: 'B',
  score: 74.2,
  basis: '3 open findings, sub-score 74',
  top: [],
  ...over,
});

const unmeasured = (name: string, over: Record<string, unknown> = {}) =>
  axis({
    axis: name,
    letter: null,
    score: null,
    basis: 'not measured for this scope — no inputs available, which is not a grade',
    ...over,
  });

describe('risk axes card', () => {
  it('shows the letter beside its basis', async () => {
    renderCard({ axes: [axis()], letter_bands: {} });
    expect(await screen.findByTestId('axis-letter-supplyChain')).toHaveTextContent('B');
    expect(screen.getByTestId('axis-basis-supplyChain')).toHaveTextContent('sub-score 74');
  });

  it('shows a DASH and a reason where no sub-score exists, never a grade', async () => {
    renderCard({ axes: [unmeasured('supplyChain')], letter_bands: {} });
    const letter = await screen.findByTestId('axis-letter-supplyChain');
    // Exact text, not toHaveTextContent: "B—" would satisfy a substring match,
    // and a letter smuggled in beside the dash is the failure we care about.
    expect(letter.textContent).toBe('—');
    expect(screen.getByTestId('axis-basis-supplyChain')).toHaveTextContent(/not measured/);
  });

  it('labels an unmeasured axis for a screen reader as unmeasured, not as a grade', async () => {
    renderCard({ axes: [unmeasured('supplyChain', { basis: 'not measured' })], letter_bands: {} });
    expect(await screen.findByLabelText(/Supply Chain not measured/)).toBeInTheDocument();
  });

  it('collapses four unmeasured axes into one summary line plus a next action', async () => {
    renderCard({
      axes: [
        unmeasured('security'),
        unmeasured('codeHealth'),
        unmeasured('supplyChain'),
        unmeasured('performance'),
      ],
      letter_bands: {},
    });

    // One line, naming all four, and it does not read as a grade.
    const summary = await screen.findByTestId('axis-unmeasured-summary');
    expect(summary).toHaveTextContent('Security, Code Health, Supply Chain, Performance');
    expect(summary).toHaveTextContent(/not measured|Not measured/);
    expect(summary).toHaveTextContent(/neither a grade nor a zero/);

    // The route out of "not measured" is stated, not just the fact.
    expect(screen.getByTestId('axis-unmeasured-next')).toHaveTextContent(/Settings → Connections/);

    // The four reasons start collapsed but are genuinely reachable.
    const details = summary.closest('details');
    expect(details?.open).toBe(false);
    await userEvent.click(summary);
    expect(details?.open).toBe(true);
    for (const key of ['security', 'codeHealth', 'supplyChain', 'performance']) {
      expect(screen.getByTestId(`axis-letter-${key}`).textContent).toBe('—');
      expect(screen.getByTestId(`axis-basis-${key}`)).toHaveTextContent(/not measured/);
      // The defect itself: four hero-sized repetitions of one sentence. Every
      // unmeasured row must live INSIDE the disclosure, or this test would pass
      // on the exact layout it was written to prevent.
      expect(screen.getByTestId(`axis-${key}`).closest('details')).not.toBeNull();
    }
  });

  it('treats a missing letter as unmeasured rather than grading it "undefined"', async () => {
    // Nothing validates the response body, so an absent field must land on the
    // unmeasured side; the alternative renders an empty span labelled a grade.
    renderCard({
      axes: [{ ...axis(), letter: undefined, score: undefined }],
      letter_bands: {},
    });
    const summary = await screen.findByTestId('axis-unmeasured-summary');
    expect(summary).toHaveTextContent('Supply Chain');
    expect(screen.getByTestId('axis-letter-supplyChain').textContent).toBe('—');
    expect(screen.getByLabelText(/Supply Chain not measured/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/grade undefined/)).toBeNull();
  });

  it('keeps measured axes at full weight and quietly names only the unmeasured ones', async () => {
    renderCard({
      axes: [
        axis({ axis: 'security', letter: 'A', basis: '0 open findings, sub-score 91' }),
        unmeasured('performance'),
      ],
      letter_bands: {},
    });

    // Measured axis stays a first-class row, outside the disclosure.
    const measuredRow = await screen.findByTestId('axis-security');
    expect(measuredRow).toHaveTextContent('A');
    expect(measuredRow.closest('details')).toBeNull();

    // Unmeasured one is named in the single quiet line — and only it.
    const summary = screen.getByTestId('axis-unmeasured-summary');
    expect(summary).toHaveTextContent('Performance');
    expect(summary).not.toHaveTextContent('Security');

    // No next-action paragraph here: the card already has something to act on.
    expect(screen.queryByTestId('axis-unmeasured-next')).toBeNull();

    // The dash and its reason survive inside the disclosure.
    await userEvent.click(summary);
    expect(screen.getByTestId('axis-letter-performance').textContent).toBe('—');
    expect(screen.getByTestId('axis-basis-performance')).toHaveTextContent(/not measured/);
  });

  it('renders no disclosure at all when every axis is measured', async () => {
    renderCard({
      axes: [
        axis(),
        axis({ axis: 'security', letter: 'A', basis: '0 open findings, sub-score 91' }),
      ],
      letter_bands: {},
    });
    await screen.findByTestId('axis-letter-supplyChain');
    expect(screen.queryByTestId('axis-unmeasured')).toBeNull();
  });
});

describe('risk axis strip', () => {
  it('shows measured letters inline and collapses the rest into a count', async () => {
    renderStrip({
      axes: [
        axis({ axis: 'security', letter: 'A', basis: '0 open findings, sub-score 91' }),
        unmeasured('codeHealth'),
        unmeasured('performance'),
      ],
      letter_bands: {},
    });

    expect(await screen.findByTestId('axis-strip-letter-security')).toHaveTextContent('A');
    const summary = screen.getByTestId('axis-strip-unmeasured-summary');
    expect(summary).toHaveTextContent('2 not measured');
    // The count alone names nothing, so the names stay in the accessible text.
    expect(summary).toHaveTextContent('Code Health, Performance');
  });

  it('keeps the dash, the reason and the "not measured" label reachable per axis', async () => {
    renderStrip({ axes: [unmeasured('performance')], letter_bands: {} });

    const summary = await screen.findByTestId('axis-strip-unmeasured-summary');
    const details = summary.closest('details');
    expect(details?.open).toBe(false);
    await userEvent.click(summary);
    expect(details?.open).toBe(true);

    expect(screen.getByTestId('axis-strip-letter-performance').textContent).toBe('—');
    expect(screen.getByTestId('axis-strip-basis-performance')).toHaveTextContent(/not measured/);
    expect(screen.getByLabelText(/Performance not measured/)).toBeInTheDocument();
  });

  it('never renders the unmeasured disclosure when all axes carry a letter', async () => {
    renderStrip({ axes: [axis()], letter_bands: {} });
    await screen.findByTestId('axis-strip-letter-supplyChain');
    expect(screen.queryByTestId('axis-strip-unmeasured')).toBeNull();
  });
});
