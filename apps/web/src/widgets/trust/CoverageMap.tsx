import type { ReactNode } from 'react';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { RuleFindingsLink, RuleRegistryLink } from '../rules/RuleFindingsLink.js';
import {
  isCoverageMap,
  SCANNER_GAP_LABEL,
  SCANNER_GAP_ORDER,
  type CoverageMapPayload,
  type CoverageSection,
} from './contracts.js';

// The repository coverage map (W18-22, E3.6).
//
// What RepoPulse did NOT look at here: languages no rule pack reads, files the
// reader skipped, scanners that are off or absent, and rules in shadow. The
// findings screens can only say what was found; this panel is what stops "no
// findings" being read as "nothing wrong".
//
// NEVER AN EMPTY GREEN PANEL (D15). Every section prints what it checked and
// from which source, an empty list says "none" beside that sentence, and a
// section with no evidence says "not known yet" — no check marks, no green,
// no overall verdict or grade (N-9).

function Section<T>({
  title,
  section,
  none,
  testId,
  children,
}: {
  title: string;
  section: CoverageSection<T>;
  none: string;
  testId: string;
  children: (items: T[]) => ReactNode;
}) {
  return (
    <section
      className="border-t border-border pt-3 first:border-t-0 first:pt-0"
      data-testid={testId}
      data-evidence={section.evidence}
      data-count={section.items.length}
    >
      <h3 className="text-sm font-medium">
        {title}
        <span className="ml-2 text-xs font-normal text-fg-muted">
          {section.evidence === 'unknown'
            ? '? not known yet'
            : section.items.length === 0
              ? '— none'
              : `${section.items.length} listed`}
        </span>
      </h3>
      <p className="mt-0.5 text-xs text-fg-muted" data-testid={`${testId}-checked`}>
        {section.checked}
      </p>
      {section.items.length > 0 ? (
        children(section.items)
      ) : section.evidence === 'known' ? (
        <p className="mt-1 text-xs text-fg-faint">{none}</p>
      ) : null}
    </section>
  );
}

export function CoverageMap({ repoId }: { repoId: string | number }) {
  const { data, isLoading, isError, error } = useApiQuery<CoverageMapPayload>({
    endpoint: '/repos/{id}/coverage-map',
    path: { id: repoId },
  });
  const map = isCoverageMap(data) ? data : null;
  const state = frameState({ isLoading, isError: isError || (!isLoading && !map), isEmpty: false });

  return (
    <WidgetFrame
      title="Coverage map — what was not looked at"
      state={state}
      {...(error
        ? { error }
        : !isLoading && !map
          ? { errorMessage: 'The coverage map could not be read.' }
          : {})}
      testId="coverage-map"
    >
      {map && (
        <div className="flex flex-col gap-3">
          <Section
            title="Languages without a rule pack"
            section={map.languages}
            none="Every language seen has at least one rule pack or the fast lane reading it."
            testId="coverage-languages"
          >
            {(items) => (
              <ul className="mt-1 flex flex-wrap gap-2 text-xs">
                {items.map((l) => (
                  <li
                    key={l.language}
                    className="rounded border border-border px-2 py-0.5"
                    data-testid={`coverage-language-${l.language}`}
                  >
                    {l.language} <span className="text-fg-muted">· {l.files} files</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {map.languages.present.length > 0 && (
            <details className="text-xs text-fg-muted" data-testid="coverage-languages-present">
              <summary className="cursor-pointer">
                {map.languages.present.length === 1
                  ? 'The 1 language seen, and what reads it'
                  : `All ${map.languages.present.length} languages seen, and what reads them`}
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {map.languages.present.map((l) => (
                  <li key={l.language}>
                    <span className="text-fg">{l.language}</span> · {l.files} files ·{' '}
                    {[...l.packs, ...(l.fastLane ? ['fast lane (in-process checks)'] : [])].join(
                      ', ',
                    ) || 'no rule pack'}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <Section
            title="Files skipped for size or the read cap"
            section={map.skippedFiles}
            none="No files were skipped on the latest read."
            testId="coverage-skipped"
          >
            {(items) => (
              <ul className="mt-1 text-xs">
                {items.map((s) => (
                  <li key={s.runId} data-testid="coverage-skipped-run">
                    {s.scannerKey} run #{s.runId}
                    {s.at ? ` on ${s.at.slice(0, 10)}` : ''}: read was partial
                    {s.count === null
                      ? ' — the number of files is not recorded'
                      : ` — ${s.count} files`}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Scanners not running here"
            section={map.scanners}
            none="Every scanner in this build is enabled and its latest run finished."
            testId="coverage-scanners"
          >
            {(items) => (
              // Grouped by WHY, worst first: a failed run and a scanner someone
              // turned off are decisions to revisit; "not in this build" is a
              // fact about the release. One flat list buried the first under
              // the last.
              <div className="mt-1 flex flex-col gap-2 text-xs">
                {SCANNER_GAP_ORDER.filter((reason) => items.some((s) => s.reason === reason)).map(
                  (reason) => (
                    <div key={reason} data-testid={`coverage-scanners-${reason}`}>
                      <h4 className="font-medium">
                        {SCANNER_GAP_LABEL[reason]}{' '}
                        <span className="font-normal text-fg-muted">
                          ({items.filter((s) => s.reason === reason).length})
                        </span>
                      </h4>
                      <ul className="mt-0.5 flex flex-col gap-0.5">
                        {items
                          .filter((s) => s.reason === reason)
                          .map((s) => (
                            <li
                              key={`${s.reason}-${s.key}`}
                              data-testid={`coverage-scanner-${s.key}`}
                              data-reason={s.reason}
                            >
                              <span>{s.label}</span>{' '}
                              <span className="text-fg-faint">— {s.detail}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ),
                )}
              </div>
            )}
          </Section>

          <Section
            title="Rules in shadow"
            section={map.shadowRules}
            none="No rule is running in shadow in this workspace."
            testId="coverage-shadow"
          >
            {(items) => (
              <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                {items.map((r) => (
                  <li key={r.ruleId} data-testid={`coverage-shadow-${r.ruleId}`}>
                    {/* W20-13 (FND-40): to its findings, and to where it is
                        promoted. */}
                    <RuleFindingsLink ruleId={r.ruleId} />{' '}
                    <span className="text-fg-muted">
                      · {r.openShadowFindings} open shadow finding
                      {r.openShadowFindings === 1 ? '' : 's'} here · from {r.source}
                    </span>
                  </li>
                ))}
                <li className="text-fg-muted">
                  Promote or retire them in <RuleRegistryLink />.
                </li>
              </ul>
            )}
          </Section>
        </div>
      )}
    </WidgetFrame>
  );
}
