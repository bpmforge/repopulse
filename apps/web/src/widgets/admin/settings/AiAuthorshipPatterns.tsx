import { useEffect, useState } from 'react';
import { WidgetFrame } from '../../../components/index.js';
import { linesOf, type AiAuthorshipPatterns, type StoredSettings } from './contracts.js';

// Admin → Settings → AI authorship patterns (W18-20).
//
// The list the AI-code governance report classifies with. Saved as ONE
// object: the API's PATCH merges top-level keys, so saving one list on its own
// would reset the other two to their defaults.
//
// Changes apply on the next read — the classification is computed when the
// report or the org tile asks, never stored — so unlike the bot list above
// there is no "from the next snapshot" caveat to print.

interface Props {
  effective: AiAuthorshipPatterns;
  defaults: AiAuthorshipPatterns;
  isDefaulted: boolean;
  saving: boolean;
  onSave: (patch: StoredSettings) => void;
}

const FIELDS: {
  key: keyof AiAuthorshipPatterns;
  id: string;
  label: string;
  help: string;
}[] = [
  {
    key: 'trailerPatterns',
    id: 'ai-trailer-patterns',
    label: 'Co-author trailer patterns',
    help: 'Matched (case-insensitive substring) against Co-authored-by, Assisted-by and Generated-by trailer values. Prefer an address such as noreply@anthropic.com over a bare name — a person can be called Claude.',
  },
  {
    key: 'botLogins',
    id: 'ai-bot-logins',
    label: 'Agent bot accounts',
    help: 'Author logins, one glob per line (a * matches anything). Checked before the bot list above, so an agent bot counts as AI-authored rather than as automation.',
  },
  {
    key: 'branchPrefixes',
    id: 'ai-branch-prefixes',
    label: 'Agent branch prefixes',
    help: 'Pull requests whose source branch starts with one of these. An empty list means branch names say nothing about authorship here.',
  },
];

export function AiAuthorshipPatternsPanel({
  effective,
  defaults,
  isDefaulted,
  saving,
  onSave,
}: Props) {
  const [text, setText] = useState<Record<keyof AiAuthorshipPatterns, string> | null>(null);

  // Seeded once per load, like the rest of this screen: re-deriving from props
  // on every refetch would overwrite what the admin is typing.
  useEffect(() => {
    setText(
      (t) =>
        t ?? {
          trailerPatterns: effective.trailerPatterns.join('\n'),
          botLogins: effective.botLogins.join('\n'),
          branchPrefixes: effective.branchPrefixes.join('\n'),
        },
    );
  }, [effective]);

  return (
    <WidgetFrame title="AI authorship patterns" state="ready" testId="ai-authorship-patterns">
      {text && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              ai_authorship_patterns: {
                trailer_patterns: linesOf(text.trailerPatterns),
                bot_logins: linesOf(text.botLogins),
                branch_prefixes: linesOf(text.branchPrefixes),
              },
            });
          }}
        >
          <p className="text-xs text-fg-muted">
            What marks a change as AI-authored in the AI-authored vs human comparison. The
            comparison is aggregate only and never names a person.
            {isDefaulted && (
              <>
                {' '}
                <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-muted">
                  default
                </span>
              </>
            )}
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {FIELDS.map((f) => (
              <label
                key={f.key}
                htmlFor={f.id}
                className="flex flex-col gap-1 text-xs text-fg-muted"
              >
                {f.label}
                <textarea
                  id={f.id}
                  rows={6}
                  className="panel px-2 py-1 font-mono text-sm"
                  data-testid={f.id}
                  value={text[f.key]}
                  onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
                />
                <span>{f.help}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="save-ai-patterns"
            >
              Save patterns
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="restore-ai-patterns"
              onClick={() =>
                setText({
                  trailerPatterns: defaults.trailerPatterns.join('\n'),
                  botLogins: defaults.botLogins.join('\n'),
                  branchPrefixes: defaults.branchPrefixes.join('\n'),
                })
              }
            >
              Restore defaults
            </button>
          </div>
          <p className="text-xs text-fg-muted">
            Applies the next time the comparison is read — reports and the overview tile classify on
            read, so history is re-classified too.
          </p>
        </form>
      )}
    </WidgetFrame>
  );
}
