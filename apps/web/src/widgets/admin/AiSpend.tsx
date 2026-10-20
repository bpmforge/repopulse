import { useState } from 'react';
import { ErrorNote, WidgetFrame } from '../../components/index.js';
import { useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// AI spend (W20-16, UX_TODO AI-08).
//
// No screen showed cost: no price per call, no token spend for hosted models,
// no money figure next to the monthly call cap. This is the honest budget
// panel: per month and model, the calls and tokens the egress audit recorded,
// and an ESTIMATE in US dollars once an admin has entered that model's price.
// RepoPulse ships no price list (it would be stale the day it shipped), so an
// unpriced model shows its tokens and "no price entered", never a guess.

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface SpendRow {
  month: string;
  model: string;
  host: string | null;
  calls: number;
  tokens_sent: number;
  tokens_received: number;
  unmeasured_calls: number;
  estimated_usd: number | null;
}

export interface Spend {
  months: number;
  prices: Record<string, ModelPrice>;
  rows: SpendRow[];
}

const LIST = { endpoint: '/admin/analysis' } as const;

const usd = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

/** "October 2026" from "2026-10". */
function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  if (!y || !mo) return m;
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Month totals: the sum of priced rows, and whether any row had no price. */
export function monthTotals(rows: SpendRow[]): {
  month: string;
  usd: number;
  unpriced: boolean;
  calls: number;
}[] {
  const by = new Map<string, { usd: number; unpriced: boolean; calls: number }>();
  for (const r of rows) {
    const t = by.get(r.month) ?? { usd: 0, unpriced: false, calls: 0 };
    t.calls += r.calls;
    if (r.estimated_usd === null) t.unpriced = true;
    else t.usd += r.estimated_usd;
    by.set(r.month, t);
  }
  return [...by.entries()].map(([month, t]) => ({ month, ...t }));
}

function PriceForm({ model, price }: { model: string; price: ModelPrice | undefined }) {
  const [input, setInput] = useState(price ? String(price.input_per_mtok) : '');
  const [output, setOutput] = useState(price ? String(price.output_per_mtok) : '');
  const save = useApiMutation<
    { model: string; input_per_mtok?: number; output_per_mtok?: number; clear?: boolean },
    unknown
  >({ endpoint: '/admin/analysis/prices', method: 'PUT' }, { invalidate: [queryKeyFor(LIST)] });
  const inNum = Number(input);
  const outNum = Number(output);
  const valid =
    input.trim() !== '' &&
    output.trim() !== '' &&
    Number.isFinite(inNum) &&
    Number.isFinite(outNum) &&
    inNum >= 0 &&
    outNum >= 0;
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-xs"
      data-testid={`price-form-${model}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate({ model, input_per_mtok: inNum, output_per_mtok: outNum });
      }}
    >
      <span className="font-mono">{model}</span>
      <label className="flex flex-col gap-0.5 text-fg-muted">
        Input $ / 1M tokens
        <input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          className="w-24 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-fg"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          data-testid={`price-input-${model}`}
        />
      </label>
      <label className="flex flex-col gap-0.5 text-fg-muted">
        Output $ / 1M tokens
        <input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          className="w-24 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-fg"
          value={output}
          onChange={(e) => setOutput(e.target.value)}
          data-testid={`price-output-${model}`}
        />
      </label>
      <button
        type="submit"
        className="rounded-md border border-accent bg-accent/10 px-2 py-0.5 disabled:opacity-50"
        disabled={!valid || save.isPending}
        data-testid={`price-save-${model}`}
      >
        Save price
      </button>
      {price && (
        <button
          type="button"
          className="panel-inset px-2 py-0.5"
          disabled={save.isPending}
          onClick={() => save.mutate({ model, clear: true })}
        >
          Remove price
        </button>
      )}
      <ErrorNote error={save.error} testId={`price-error-${model}`} />
    </form>
  );
}

export function AiSpend({ spend }: { spend: Spend | undefined }) {
  if (!spend) return null;
  const totals = monthTotals(spend.rows);
  const models = [
    ...new Set(spend.rows.map((r) => r.model).concat(Object.keys(spend.prices))),
  ].sort();
  return (
    <WidgetFrame
      title={`AI spend (last ${spend.months} months)`}
      state={spend.rows.length === 0 ? 'empty' : 'ready'}
      emptyMessage="Nothing has been sent to a model off your network in this period, so there is nothing to pay for. Models on your own network are not counted here: they cost no per-call money."
    >
      <div className="flex flex-col gap-3" data-testid="ai-spend">
        <ul className="flex flex-wrap gap-3 text-sm" data-testid="ai-spend-months">
          {totals.map((t) => (
            <li key={t.month} className="panel-inset px-3 py-2">
              <span className="block text-xs text-fg-muted">{monthLabel(t.month)}</span>
              <span className="tabular-nums" data-testid={`ai-spend-month-${t.month}`}>
                {t.usd > 0 || !t.unpriced ? usd(t.usd) : 'no price entered'}
                {t.unpriced && t.usd > 0 ? ' + unpriced models' : ''}
              </span>
              <span className="block text-xs text-fg-faint">
                {t.calls} call{t.calls === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">AI spend by month and model</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Month</th>
                <th scope="col">Model</th>
                <th scope="col">Sent to</th>
                <th scope="col" className="text-right">
                  Calls
                </th>
                <th scope="col" className="text-right">
                  Tokens in / out
                </th>
                <th scope="col" className="text-right">
                  Estimate
                </th>
              </tr>
            </thead>
            <tbody data-testid="ai-spend-rows">
              {spend.rows.map((r) => (
                <tr
                  key={`${r.month}-${r.model}-${r.host ?? ''}`}
                  className="border-t border-border"
                >
                  <td className="py-1 text-xs">{monthLabel(r.month)}</td>
                  <td className="py-1 font-mono text-xs">{r.model}</td>
                  <td className="py-1 text-xs text-fg-muted">{r.host ?? '—'}</td>
                  <td className="py-1 text-right tabular-nums text-xs">{r.calls}</td>
                  <td className="py-1 text-right tabular-nums text-xs">
                    {tokens(r.tokens_sent)} / {tokens(r.tokens_received)}
                    {r.unmeasured_calls > 0 ? (
                      <span className="block text-fg-faint">
                        {r.unmeasured_calls} call{r.unmeasured_calls === 1 ? '' : 's'} reported no
                        token count
                      </span>
                    ) : null}
                  </td>
                  <td
                    className="py-1 text-right tabular-nums text-xs"
                    data-testid={`ai-spend-estimate-${r.month}-${r.model}`}
                  >
                    {r.estimated_usd === null ? (
                      <span className="text-fg-muted">no price entered</span>
                    ) : (
                      usd(r.estimated_usd)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="text-xs" data-testid="ai-spend-prices">
          <summary className="cursor-pointer text-fg-muted">
            Prices ({Object.keys(spend.prices).length} of {models.length} models priced)
          </summary>
          <p className="mt-1 text-fg-muted">
            Enter what your provider charges, in US dollars per million tokens. The estimate is
            tokens &times; price, from the token counts each provider reported; your invoice is the
            real figure. A Claude Code CLI connection runs on a flat-rate plan, so leave it
            unpriced.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {models.map((m) => (
              <PriceForm key={m} model={m} price={spend.prices[m]} />
            ))}
          </div>
        </details>
        <p className="text-xs text-fg-faint">
          Counted from the egress audit, so only calls that left your network appear. Models on your
          own network are not counted: they cost no per-call money.
        </p>
      </div>
    </WidgetFrame>
  );
}
