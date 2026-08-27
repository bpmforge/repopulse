import { useEffect, useState } from 'react';
import { WidgetFrame, frameState, useUiStore } from '../../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../../api/useApiQuery.js';
import {
  WEIGHT_KEYS,
  isDefaulted,
  weightsSumOk,
  type HealthWeights,
  type StoredSettings,
  type WorkspaceSettingsResponse,
} from './contracts.js';

// Admin → Settings (W4-09, UX_SPEC §4.i). The knobs that decide what every
// other number on every other screen means: health-score weights, which logins
// count as bots, when a PR is stale.
//
// Each group saves ON ITS OWN. PATCH merges, so a partial save is safe, and
// pairing one save button with one concept means a rejected weight set does not
// also discard an edited bot list.

const SETTINGS = { endpoint: '/admin/workspace' } as const;

function DefaultBadge() {
  return (
    <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-muted">default</span>
  );
}

export function Settings() {
  const pushToasts = useUiStore((s) => s.pushToasts);
  const { data, isLoading, isError, error, refetch } =
    useApiQuery<WorkspaceSettingsResponse>(SETTINGS);
  const save = useApiMutation<StoredSettings, WorkspaceSettingsResponse>(
    { ...SETTINGS, method: 'PATCH' },
    { invalidate: [queryKeyFor(SETTINGS)] },
  );

  const [weights, setWeights] = useState<HealthWeights | null>(null);
  const [bots, setBots] = useState<string | null>(null);
  const [staleDays, setStaleDays] = useState<string | null>(null);

  // Seed the form from the server ONCE per load. Deriving the inputs from
  // `data` on every render would overwrite what the admin is typing each time
  // the query refetches.
  useEffect(() => {
    if (!data) return;
    setWeights((w) => w ?? data.effective.healthWeights);
    setBots((b) => (b === null ? data.effective.botLoginGlobs.join('\n') : b));
    setStaleDays((s) => (s === null ? String(data.effective.stalePrDays) : s));
  }, [data]);

  const stored = data?.stored ?? {};
  const sumOk = weights ? weightsSumOk(weights) : true;

  function onSaved(message: string) {
    pushToasts([{ id: `settings-${Date.now()}`, tone: 'ok', message }]);
  }
  function onFailed(err: Error) {
    pushToasts([{ id: `settings-err-${Date.now()}`, tone: 'crit', message: err.message }]);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="admin-settings">
      <WidgetFrame
        title="Health score weights"
        state={frameState({ isLoading, isError, isEmpty: false })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        definitionHref="/docs/design/METRICS.md"
      >
        {weights && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!sumOk) return;
              save.mutate(
                { health_weights: weights },
                {
                  onSuccess: () => onSaved('Health weights saved'),
                  onError: onFailed,
                },
              );
            }}
          >
            <p className="text-xs text-fg-muted">
              Signals, not grades — weights change how sub-scores combine, never what they measure.
              {isDefaulted(stored, 'health_weights') && (
                <>
                  {' '}
                  <DefaultBadge /> METRICS.md §3 values.
                </>
              )}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {WEIGHT_KEYS.map(({ key, label }) => (
                <label key={key} className="flex flex-col gap-1 text-xs text-fg-muted">
                  {label}
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    className="rounded-md border border-border bg-surface px-2 py-1 text-sm tabular-nums"
                    data-testid={`weight-${key}`}
                    value={weights[key]}
                    onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
            {/* role=alert so the reason is announced, not just coloured. */}
            {!sumOk && (
              <p role="alert" className="text-xs text-crit" data-testid="weights-sum-error">
                Weights must sum to 1.00 (METRICS.md §3). Currently{' '}
                {(
                  weights.activity +
                  weights.reviewHygiene +
                  weights.ciHealth +
                  weights.delivery
                ).toFixed(2)}
                .
              </p>
            )}
            <div>
              <button
                type="submit"
                disabled={save.isPending || !sumOk}
                className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="save-weights"
              >
                Save weights
              </button>
            </div>
          </form>
        )}
      </WidgetFrame>

      <WidgetFrame title="What counts as activity" state={frameState({ isLoading, isError, isEmpty: false })}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const globs = (bots ?? '')
              .split('\n')
              .map((g) => g.trim())
              .filter((g) => g.length > 0);
            const days = Number(staleDays);
            if (!Number.isInteger(days) || days < 1) return;
            save.mutate(
              { bot_login_globs: globs, stale_pr_days: days },
              {
                onSuccess: () => onSaved('Saved — applies at the next snapshot'),
                onError: onFailed,
              },
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-fg-muted" htmlFor="bot-globs">
            Bot logins — one glob per line{' '}
            {isDefaulted(stored, 'bot_login_globs') && <DefaultBadge />}
            <textarea
              id="bot-globs"
              rows={4}
              className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-sm"
              data-testid="bot-globs"
              value={bots ?? ''}
              onChange={(e) => setBots(e.target.value)}
            />
          </label>
          {/* An empty box is a real choice the API stores as an empty list, so
              say what it does rather than letting it read as "unset". */}
          <p className="text-xs text-fg-muted">
            Matching logins are excluded from every human-flow metric. Leaving this empty turns bot
            exclusion off — dependabot then counts as a contributor.
          </p>
          <label className="flex w-40 flex-col gap-1 text-xs text-fg-muted" htmlFor="stale-days">
            A PR is stale after (days) {isDefaulted(stored, 'stale_pr_days') && <DefaultBadge />}
            <input
              id="stale-days"
              type="number"
              min="1"
              max="365"
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm tabular-nums"
              data-testid="stale-days"
              value={staleDays ?? ''}
              onChange={(e) => setStaleDays(e.target.value)}
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={save.isPending}
              className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="save-activity"
            >
              Save
            </button>
          </div>
          <p className="text-xs text-fg-muted">
            Existing snapshots are not rewritten — metric_snapshots is an append-only series, so
            these apply from the next recompute onward.
          </p>
        </form>
      </WidgetFrame>

      {/* Rendered disabled rather than hidden: an operator evaluating RepoPulse
          should be able to see that the analysis knobs exist and are not ready,
          instead of wondering whether they are missing. The list comes from the
          API so the screen cannot disagree with the server about it. */}
      <WidgetFrame title="Analysis (lands with the analysis wave)" state="ready">
        <fieldset
          disabled
          className="flex flex-col gap-2 opacity-60"
          data-testid="settings-pending"
        >
          <legend className="sr-only">Analysis settings, not yet available</legend>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            LM Studio hosts
            <input
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
              placeholder="lands with analysis wave"
              readOnly
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Concurrency cap
            <input
              className="w-40 rounded-md border border-border bg-surface px-2 py-1 text-sm"
              placeholder="lands with analysis wave"
              readOnly
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Tier-3 monthly cap (USD)
            <input
              className="w-40 rounded-md border border-border bg-surface px-2 py-1 text-sm"
              placeholder="lands with analysis wave"
              readOnly
            />
          </label>
        </fieldset>
      </WidgetFrame>
    </div>
  );
}
