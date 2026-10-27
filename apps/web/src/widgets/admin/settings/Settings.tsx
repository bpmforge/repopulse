import { Link, useBlocker } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { WidgetFrame, errorToast, frameState, useUiStore } from '../../../components/index.js';
import { docsUrl } from '../../../lib/docs.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../../api/useApiQuery.js';
import {
  WEIGHT_KEYS,
  effectiveShares,
  isDefaulted,
  weightsSumOk,
  type HealthWeights,
  type SettingsPatch,
  type WorkspaceSettingsResponse,
} from './contracts.js';
import { AiAuthorshipPatternsPanel } from './AiAuthorshipPatterns.js';
import { LicensePolicyPanel } from './LicensePolicy.js';
import { DebtTargetsPanel } from './DebtTargets.js';

// Settings → Scoring (W4-09, UX_SPEC §4.i). The knobs that decide what every
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
  const save = useApiMutation<SettingsPatch, WorkspaceSettingsResponse>(
    { ...SETTINGS, method: 'PATCH' },
    { invalidate: [queryKeyFor(SETTINGS)] },
  );

  const [weights, setWeights] = useState<HealthWeights | null>(null);
  const [bots, setBots] = useState<string | null>(null);
  const [staleDays, setStaleDays] = useState<string | null>(null);
  const [staleProblem, setStaleProblem] = useState<string | null>(null);

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

  // W20-17 (UX_TODO ADM-17): leaving with unsaved edits asked nothing and
  // lost them. Dirty = the form differs from what the server says is in effect.
  const eff = data?.effective;
  const dirty =
    eff !== undefined &&
    ((weights !== null && WEIGHT_KEYS.some(({ key }) => weights[key] !== eff.healthWeights[key])) ||
      (bots !== null && bots !== eff.botLoginGlobs.join('\n')) ||
      (staleDays !== null && staleDays !== String(eff.stalePrDays)));
  useBlocker({
    shouldBlockFn: () =>
      !window.confirm('You have unsaved settings on this page. Leave without saving them?'),
    disabled: !dirty,
    enableBeforeUnload: () => dirty,
  });

  /**
   * Restore defaults for one group (W20-17, UX_TODO ADM-56): `null` removes the
   * stored override, the default badge returns, and the form shows the
   * documented values again.
   */
  function restore(keys: (keyof SettingsPatch)[], label: string) {
    const patch: SettingsPatch = {};
    for (const k of keys) patch[k] = null;
    save.mutate(patch, {
      onSuccess: (res) => {
        if (keys.includes('health_weights')) setWeights(res.effective.healthWeights);
        if (keys.includes('bot_login_globs')) setBots(res.effective.botLoginGlobs.join('\n'));
        if (keys.includes('stale_pr_days')) setStaleDays(String(res.effective.stalePrDays));
        setStaleProblem(null);
        onSaved(`${label} restored to defaults`);
      },
      onError: onFailed,
    });
  }

  function onSaved(message: string) {
    pushToasts([{ id: `settings-${Date.now()}`, tone: 'ok', message }]);
  }
  function onFailed(err: Error) {
    // W20-04 (UX_TODO ADM-12): the detail says WHICH value was refused and why.
    pushToasts([errorToast(`settings-err-${Date.now()}`, err)]);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="admin-settings">
      <WidgetFrame
        title="Health score weights"
        state={frameState({ isLoading, isError, isEmpty: false })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        definitionHref={docsUrl('/docs/design/METRICS.md')}
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
                  <DefaultBadge /> The documented starting values.
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
                    className="panel px-2 py-1 text-sm tabular-nums"
                    data-testid={`weight-${key}`}
                    value={weights[key]}
                    onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
            {/* W20-22 (UX_TODO ADM-60): all seven sub-scores, and what each
                really counts for once the three measured-only ones are in. */}
            <table className="table-plain w-full text-xs" data-testid="weights-effective">
              {/* pb-2 (W21-01): the caption sat flush on the header row. */}
              <caption className="pb-2 text-left leading-relaxed text-fg-muted">
                The four above add up to 1.00. Security, code health and supply chain are added on
                top when a repository has been scanned for them, and then every weight is scaled so
                the total is 100 %. A repository without those scans uses the four alone.
              </caption>
              <thead>
                <tr className="text-left text-fg-muted">
                  <th scope="col">Sub-score</th>
                  <th scope="col">Weight</th>
                  <th scope="col">Share when fully measured</th>
                </tr>
              </thead>
              <tbody>
                {effectiveShares(weights).map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <th scope="row" className="py-1 text-left font-normal">
                      {r.label}
                      {!r.editable && (
                        <span className="text-fg-muted"> (fixed; only used when measured)</span>
                      )}
                    </th>
                    <td className="py-1 tabular-nums">{r.weight.toFixed(2)}</td>
                    <td className="py-1 tabular-nums" data-testid={`weight-share-${r.key}`}>
                      {Math.round(r.share * 100)} %
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* role=alert so the reason is announced, not just coloured. */}
            {!sumOk && (
              <p role="alert" className="text-xs text-crit" data-testid="weights-sum-error">
                Weights must add up to 1.00. Currently{' '}
                {(
                  weights.activity +
                  weights.reviewHygiene +
                  weights.ciHealth +
                  weights.delivery
                ).toFixed(2)}
                .
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={save.isPending || !sumOk}
                className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="save-weights"
              >
                Save weights
              </button>
              {!isDefaulted(stored, 'health_weights') && (
                <button
                  type="button"
                  className="text-xs text-accent hover:underline disabled:opacity-50"
                  data-testid="restore-weights"
                  disabled={save.isPending}
                  onClick={() => restore(['health_weights'], 'Health weights')}
                >
                  Restore defaults
                </button>
              )}
            </div>
          </form>
        )}
      </WidgetFrame>

      <WidgetFrame
        title="What counts as activity"
        state={frameState({ isLoading, isError, isEmpty: false })}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const globs = (bots ?? '')
              .split('\n')
              .map((g) => g.trim())
              .filter((g) => g.length > 0);
            const days = Number(staleDays);
            if (!Number.isInteger(days) || days < 1 || days > 365) {
              // W20-17 (UX_TODO ADM-17): it refused without a word.
              setStaleProblem('Enter a whole number of days from 1 to 365.');
              return;
            }
            setStaleProblem(null);
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
              className="panel px-2 py-1 font-mono text-sm"
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
              className="panel px-2 py-1 text-sm tabular-nums"
              data-testid="stale-days"
              value={staleDays ?? ''}
              aria-invalid={staleProblem !== null}
              onChange={(e) => {
                setStaleDays(e.target.value);
                setStaleProblem(null);
              }}
            />
          </label>
          {staleProblem && (
            <p role="alert" className="text-xs text-crit" data-testid="stale-days-error">
              {staleProblem}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={save.isPending}
              className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="save-activity"
            >
              Save
            </button>
            {(!isDefaulted(stored, 'bot_login_globs') || !isDefaulted(stored, 'stale_pr_days')) && (
              <button
                type="button"
                className="text-xs text-accent hover:underline disabled:opacity-50"
                data-testid="restore-activity"
                disabled={save.isPending}
                onClick={() => restore(['bot_login_globs', 'stale_pr_days'], 'Activity settings')}
              >
                Restore defaults
              </button>
            )}
          </div>
          {/* W20-17 (UX_TODO ADM-18): plain words; the table name meant nothing. */}
          <p className="text-xs text-fg-muted">
            Past scores are not recalculated; changes apply from the next daily update.
          </p>
        </form>
      </WidgetFrame>

      {data?.effective.aiAuthorshipPatterns && data.defaults.aiAuthorshipPatterns && (
        <AiAuthorshipPatternsPanel
          effective={data.effective.aiAuthorshipPatterns}
          defaults={data.defaults.aiAuthorshipPatterns}
          isDefaulted={isDefaulted(stored, 'ai_authorship_patterns')}
          saving={save.isPending}
          onSave={(patch) =>
            save.mutate(patch, {
              onSuccess: () => onSaved('AI authorship patterns saved'),
              onError: onFailed,
            })
          }
        />
      )}

      {/* W20-08 (UX_TODO FND-18): the license register's policy. */}
      {data?.effective.licensePolicy && data.defaults.licensePolicy && (
        <LicensePolicyPanel
          effective={data.effective.licensePolicy}
          defaults={data.defaults.licensePolicy}
          isDefaulted={isDefaulted(stored, 'license_policy')}
          saving={save.isPending}
          onSave={(patch) =>
            save.mutate(patch, {
              onSuccess: () => onSaved('License policy saved — applies from the next scan'),
              onError: onFailed,
            })
          }
        />
      )}

      {/* W20-24 (UX_TODO DSH-31): debt-signal targets, none by default. */}
      {data?.effective.debtTargets && (
        <DebtTargetsPanel
          effective={data.effective.debtTargets}
          isDefaulted={isDefaulted(stored, 'debt_targets')}
          saving={save.isPending}
          onSave={(targets) =>
            save.mutate(
              // An empty set is "no targets": the stored key goes, so the
              // tab shows no target line at all.
              { debt_targets: Object.keys(targets).length === 0 ? null : targets },
              {
                onSuccess: () => onSaved('Debt signal targets saved'),
                onError: onFailed,
              },
            )
          }
        />
      )}

      {/* WHERE EACH OF THESE ACTUALLY LIVES (W16-57).
          This was three disabled inputs under the heading "Analysis (lands
          with the analysis wave)", every one captioned "lands with analysis
          wave". The wave landed: LM Studio hosts moved to Settings → Models —
          which is two tabs away, needs no restart, and was used to configure a
          model minutes before this screen said the feature was pending — and
          the concurrency cap is an environment variable with a default. The
          third has no implementation at all, which is worth SAYING rather than
          implying with a greyed-out box that it is nearly here.

          Kept as a section rather than deleted, for the reason the disabled
          fields were rendered in the first place: an operator evaluating
          RepoPulse should be able to find these knobs, not wonder whether they
          exist. It just has to point at the truth. */}
      <WidgetFrame title="Analysis settings" state="ready">
        <ul className="flex flex-col gap-2 text-sm" data-testid="settings-analysis-pointers">
          <li>
            <span className="text-fg">Models and endpoints</span> —{' '}
            <Link to="/admin/models" className="text-accent hover:underline">
              Settings → Models
            </Link>
            . Add a local or hosted OpenAI-compatible endpoint, test it, and see what answered.
          </li>
          {/* W20-17 (UX_TODO ADM-18): what each knob does first; the variable
              name is for whoever edits deploy/.env. */}
          <li>
            <span className="text-fg">How many requests one model machine handles at once</span> —
            set at install time, not here (default 1), because it describes the machine the model
            runs on, not the organization being measured. Your operator changes it with the{' '}
            <code className="font-mono text-xs">LMSTUDIO_CONCURRENCY</code> setting.
          </li>
          <li>
            <span className="text-fg">AI spend</span> — estimated per month and model on the{' '}
            <Link to="/admin/analysis" className="text-accent hover:underline">
              Analysis
            </Link>{' '}
            tab (W20-16), from the tokens each hosted model reported and the prices you enter there.
            The limit that stops spending is the monthly cap on model calls for scheduled passes;
            there is no limit in money.
          </li>
        </ul>
      </WidgetFrame>
    </div>
  );
}
