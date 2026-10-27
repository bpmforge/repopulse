import { useEffect, useState } from 'react';
import { WidgetFrame } from '../../../components/index.js';
import {
  LICENSE_CATEGORY_LABEL,
  linesOf,
  type LicenseCategory,
  type LicensePolicy,
  type StoredSettings,
} from './contracts.js';

// Settings → Scoring → License policy (W20-08, UX_TODO FND-18).
//
// The license register has applied a workspace policy since W18-39, and there
// was no way to set one: the key was missing from the settings schema. Saved
// as ONE object, like the AI patterns above, because PATCH merges top-level
// keys only.

interface Props {
  effective: LicensePolicy;
  defaults: LicensePolicy;
  isDefaulted: boolean;
  saving: boolean;
  onSave: (patch: StoredSettings) => void;
}

interface Draft {
  categories: LicenseCategory[];
  flagUnknown: boolean;
  allow: string;
  flag: string;
}

function draftOf(p: LicensePolicy): Draft {
  return {
    categories: [...p.flagCategories],
    flagUnknown: p.flagUnknown,
    allow: p.allow.join('\n'),
    flag: p.flag.join('\n'),
  };
}

/** The PATCH body for a draft. Exported for the test. */
export function licensePolicyPatch(d: Draft): StoredSettings {
  return {
    license_policy: {
      flag_categories: d.categories,
      flag_unknown: d.flagUnknown,
      allow: linesOf(d.allow),
      flag: linesOf(d.flag),
    },
  };
}

export function LicensePolicyPanel({ effective, defaults, isDefaulted, saving, onSave }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);

  // Seeded once per load: re-deriving on every refetch would overwrite edits.
  useEffect(() => {
    setDraft((d) => d ?? draftOf(effective));
  }, [effective]);

  return (
    <WidgetFrame title="License policy" state="ready" testId="license-policy">
      {draft && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(licensePolicyPatch(draft));
          }}
        >
          <p className="text-xs text-fg-muted">
            Which dependency licenses the license register raises as findings. Applies to
            production-scope dependencies, from the next scan. A posture check, not legal advice.
            {isDefaulted && (
              <>
                {' '}
                <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-muted">
                  default
                </span>
              </>
            )}
          </p>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="text-xs text-fg-muted">Flag these license categories</legend>
            {(Object.keys(LICENSE_CATEGORY_LABEL) as LicenseCategory[]).map((c) => (
              <label key={c} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid={`license-category-${c}`}
                  checked={draft.categories.includes(c)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      categories: e.target.checked
                        ? [...draft.categories, c]
                        : draft.categories.filter((x) => x !== c),
                    })
                  }
                />
                {LICENSE_CATEGORY_LABEL[c]}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="license-flag-unknown"
              checked={draft.flagUnknown}
              onChange={(e) => setDraft({ ...draft, flagUnknown: e.target.checked })}
            />
            Flag a dependency whose license could not be read
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label htmlFor="license-allow" className="flex flex-col gap-1 text-xs text-fg-muted">
              Always allow (SPDX ids, one per line)
              <textarea
                id="license-allow"
                rows={5}
                className="panel px-2 py-1 font-mono text-sm"
                data-testid="license-allow"
                value={draft.allow}
                onChange={(e) => setDraft({ ...draft, allow: e.target.value })}
              />
              <span>Wins over the categories, e.g. MPL-2.0 when weak copyleft is flagged.</span>
            </label>
            <label htmlFor="license-flag" className="flex flex-col gap-1 text-xs text-fg-muted">
              Always flag (SPDX ids, one per line)
              <textarea
                id="license-flag"
                rows={5}
                className="panel px-2 py-1 font-mono text-sm"
                data-testid="license-flag"
                value={draft.flag}
                onChange={(e) => setDraft({ ...draft, flag: e.target.value })}
              />
              <span>Flagged whatever their category.</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="save-license-policy"
            >
              Save policy
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="restore-license-policy"
              onClick={() => setDraft(draftOf(defaults))}
            >
              Restore defaults
            </button>
          </div>
        </form>
      )}
    </WidgetFrame>
  );
}
