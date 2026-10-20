import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';
import {
  pausedLine,
  routeLabel,
  VERDICT_SENTENCE,
  type AiPause,
  type AiSuggestion,
  type SecondOpinionInfo,
} from './aiContracts.js';

// A second opinion on an AI triage suggestion (W20-18, UX_TODO AI-14).
//
// The first answer came from one model; nothing let anyone cross-check it. An
// admin can now ask ANOTHER model the same question from the same stored lines,
// and the drawer shows whether it agrees. Decision 2026-10-20: a hosted model
// (off your network) only on a repository opted in to Tier 3, and each ask is a
// pass, counted against the daily limit. Like every AI answer it is a lead, not
// a result, and it changes nothing about the finding.

const ACTION =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/** Another model's answer, shown under the suggestion it checks. */
export function SecondOpinionAnswer({
  first,
  second,
}: {
  first: AiSuggestion;
  second: AiSuggestion;
}) {
  const agrees = first.verdict === second.verdict;
  return (
    <div
      className="flex flex-col gap-1 rounded-sm border border-border px-2 py-1.5"
      data-testid={`ai-second-opinion-${second.id}`}
      data-agrees={agrees ? 'true' : 'false'}
    >
      <p className="text-xs">
        <span className="font-medium">Second opinion</span> from{' '}
        {routeLabel(second.route, second.model)}:{' '}
        <strong data-testid="ai-second-opinion-agreement">{agrees ? 'agrees' : 'disagrees'}</strong>
        . {VERDICT_SENTENCE[second.verdict]}{' '}
        <span className="text-fg-muted">AI confidence {second.confidence}/5.</span>
      </p>
      <p className="text-xs text-fg-muted">{second.rationale}</p>
      {second.citations.length > 0 ? (
        <p className="text-xs text-fg-faint">
          Cited{' '}
          {second.citations.map((c, i) => (
            <span key={i} className="font-mono">
              {i > 0 ? ', ' : ''}
              {c.file}:{c.line}
            </span>
          ))}
          .
        </p>
      ) : null}
      {!agrees ? (
        <p className="text-xs text-fg" data-testid="ai-second-opinion-disagree-note">
          The two models disagree: read the cited lines yourself before answering.
        </p>
      ) : null}
    </div>
  );
}

/** "Ask another model": who, where the code would go, and what it costs. */
export function AskSecondOpinion({
  findingId,
  info,
  isAdmin,
  paused,
  invalidate,
}: {
  findingId: number;
  info: SecondOpinionInfo;
  isAdmin: boolean;
  paused: AiPause | undefined;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const ask = useApiMutation<{ provider_id: number }, unknown>(
    {
      endpoint: '/findings/{id}/ai-verdicts/{verdictId}/second-opinion',
      path: { id: findingId, verdictId: info.of },
      method: 'POST',
    },
    { invalidate },
  );
  const choice = info.choices.find((c) => c.provider_id === picked) ?? info.choices[0];
  const latest = info.latest;
  const inFlight = latest?.status === 'pending' || latest?.status === 'running';
  const off = pausedLine(paused, 'no second opinion can be asked');
  const atLimit = info.passes_today >= info.passes_per_day;

  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="ai-second-opinion-ask">
      {inFlight ? (
        <p role="status" className="text-fg-muted" data-testid="ai-second-opinion-pending">
          Asking {latest.destination?.model ?? 'another model'} for a second opinion…
        </p>
      ) : latest?.status === 'failed' || latest?.status === 'skipped' ? (
        <p className="text-fg-muted" data-testid="ai-second-opinion-failed">
          The last second opinion could not be made
          {latest.reason ? `: ${latest.reason}` : '.'}
        </p>
      ) : null}
      {off ? (
        <p className="text-fg-muted" data-testid="ai-second-opinion-paused">
          {off}
        </p>
      ) : !isAdmin ? (
        <p className="text-fg-faint">An admin can ask another model for a second opinion.</p>
      ) : info.choices.length === 0 ? (
        <p className="text-fg-muted" data-testid="ai-second-opinion-none">
          No other model can give a second opinion here
          {info.blocked.length > 0
            ? `: ${info.blocked.map((b) => `${b.provider_name} (${b.reason})`).join('; ')}`
            : ''}
          .{' '}
          <Link to="/admin/models" className="underline underline-offset-2">
            Add a model in Admin → Models
          </Link>
          .
        </p>
      ) : inFlight ? null : (
        <>
          {info.choices.length > 1 ? (
            <label className="flex flex-wrap items-center gap-2 text-fg-muted">
              Model
              <select
                className="panel px-2 py-1 text-xs"
                data-testid="ai-second-opinion-model"
                value={choice?.provider_id}
                onChange={(e) => setPicked(Number(e.target.value))}
              >
                {info.choices.map((c) => (
                  <option key={c.provider_id} value={c.provider_id}>
                    {c.provider_name} · {c.model}
                    {c.leaves_network ? ' (off your network)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {choice ? (
            <p
              className={choice.leaves_network ? 'text-fg' : 'text-fg-muted'}
              data-testid="ai-second-opinion-destination"
              data-leaves={choice.leaves_network ? 'true' : 'false'}
            >
              {choice.leaves_network ? (
                <>
                  <strong>Leaves your network:</strong> {choice.provider_name} (
                  <span className="font-mono">{choice.host ?? 'unknown host'}</span>) would receive{' '}
                  {info.sends}. Allowed because this repository is opted in to Tier 3; the request
                  is recorded in the egress audit.
                </>
              ) : (
                <>
                  Stays on your network: {choice.provider_name} (
                  <span className="font-mono">{choice.host ?? 'unknown host'}</span>) receives{' '}
                  {info.sends}.
                </>
              )}
            </p>
          ) : null}
          <p className="text-fg-faint" data-testid="ai-second-opinion-limit">
            Counts as one of the {info.passes_per_day} AI passes a day ({info.passes_today} used in
            the last 24 hours).
            {!info.tier3_opt_in && info.blocked.length > 0
              ? ' Models off your network are offered only on repositories opted in to Tier 3.'
              : ''}
          </p>
          <div>
            <button
              type="button"
              className={ACTION}
              data-testid="ai-second-opinion-button"
              disabled={ask.isPending || atLimit || !choice}
              aria-busy={ask.isPending || undefined}
              onClick={() => choice && ask.mutate({ provider_id: choice.provider_id })}
            >
              {ask.isPending
                ? 'Asking…'
                : `Ask ${choice?.model ?? 'another model'} for a second opinion`}
            </button>
          </div>
        </>
      )}
      <ErrorNote error={ask.error} testId="ai-second-opinion-error" />
    </div>
  );
}
