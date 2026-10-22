import { useEffect, useState } from 'react';
import { WidgetFrame } from '../../../components/index.js';
import {
  DEBT_SIGNALS,
  debtTargetToForm,
  debtTargetsFromForm,
  type DebtSignalKey,
  type DebtTargets,
} from './contracts.js';

// Admin → Settings → Debt signal targets (W20-24, UX_TODO DSH-31; decision
// 2026-10-21: per-workspace targets, none by default).
//
// Every debt signal is lower-is-better, so a target is a ceiling. A blank box
// is "no target" for that signal, and the Code Health tab then shows the value
// and its change alone, as before.

interface Props {
  effective: DebtTargets;
  isDefaulted: boolean;
  saving: boolean;
  onSave: (targets: DebtTargets) => void;
}

type Form = Partial<Record<DebtSignalKey, string>>;

function formOf(t: DebtTargets): Form {
  return Object.fromEntries(DEBT_SIGNALS.map((s) => [s.key, debtTargetToForm(s.key, t[s.key])]));
}

export function DebtTargetsPanel({ effective, isDefaulted, saving, onSave }: Props) {
  const [form, setForm] = useState<Form | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Seeded once per load: re-deriving on every refetch would overwrite edits.
  useEffect(() => {
    setForm((f) => f ?? formOf(effective));
  }, [effective]);

  return (
    <WidgetFrame title="Debt signal targets" state="ready" testId="debt-targets">
      {form && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = debtTargetsFromForm(form);
            if ('problem' in parsed) {
              setProblem(parsed.problem);
              return;
            }
            setProblem(null);
            onSave(parsed.targets);
          }}
        >
          <p className="text-xs text-fg-muted">
            The most each Code Health debt signal should be, for every repository in this workspace.
            Leave a box empty for no target; the Code Health tab then shows the value and its change
            only.
            {isDefaulted && ' No targets are set.'}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {DEBT_SIGNALS.map((s) => (
              <label key={s.key} className="flex flex-col gap-1 text-xs text-fg-muted">
                {s.label} (at most, {s.unit})
                <input
                  type="number"
                  min="0"
                  step="any"
                  className="panel px-2 py-1 text-sm tabular-nums"
                  data-testid={`debt-target-${s.key}`}
                  value={form[s.key] ?? ''}
                  placeholder="no target"
                  onChange={(e) => {
                    setForm({ ...form, [s.key]: e.target.value });
                    setProblem(null);
                  }}
                />
              </label>
            ))}
          </div>
          {problem && (
            <p role="alert" className="text-xs text-crit" data-testid="debt-targets-error">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="save-debt-targets"
            >
              Save targets
            </button>
            {!isDefaulted && (
              <button
                type="button"
                className="text-xs text-accent hover:underline disabled:opacity-50"
                data-testid="clear-debt-targets"
                disabled={saving}
                onClick={() => {
                  setForm(formOf({}));
                  onSave({});
                }}
              >
                Clear all targets
              </button>
            )}
          </div>
        </form>
      )}
    </WidgetFrame>
  );
}
