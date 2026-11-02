import { createFileRoute } from '@tanstack/react-router';
import { PageHeader, WidgetFrame, frameState } from '../components/index.js';
import { useApiQuery } from '../api/useApiQuery.js';
import { docsUrl } from '../lib/docs.js';
import {
  RELEASE_ACCURACY,
  percent,
  type AccuracyRow,
  type ReleaseAccuracy,
} from '../about/accuracy.js';

// About (W20-23, UX_TODO X-11; W20_DECISIONS_2 row 8). Open to every signed-in
// person, unlike Settings → Rules, which was the only place the benchmark
// numbers could be seen. It answers two questions: which release is installed,
// and how accurate this release's deterministic checks measured. The version
// comes from the API (the install's own tag); the numbers ship in the bundle.

export const Route = createFileRoute('/about')({ component: AboutRoute });

function AboutRoute() {
  return <AboutPage accuracy={RELEASE_ACCURACY} />;
}

const KIND_WORDS: Record<AccuracyRow['kind'], string> = {
  public: 'Public benchmark',
  own: 'Our corpus',
};

export function AboutPage({ accuracy }: { accuracy: ReleaseAccuracy }) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ version: string }>({
    endpoint: '/about',
  });
  const installed = data?.version;
  const commit = accuracy.measured.commit.slice(0, 12);

  return (
    <div className="flex flex-col gap-4" data-testid="about">
      <PageHeader
        title="About RepoPulse"
        description="Which release this is, and how accurate its checks measured on labelled code."
      />

      <WidgetFrame
        title="Installed release"
        state={frameState({ isLoading, isError, isEmpty: false })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        testId="about-version-frame"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-muted">Version</dt>
          <dd className="font-mono" data-testid="about-version">
            {installed ?? '…'}
          </dd>
          <dt className="text-fg-muted">Accuracy published with</dt>
          <dd className="font-mono" data-testid="about-accuracy-release">
            {accuracy.release}
          </dd>
          {/* The licence the install ships under. LICENSE, NOTICE and
              THIRD_PARTY_NOTICES.md are in every image and bundle (W23-11);
              this says so where an operator looks for the version. */}
          <dt className="text-fg-muted">Licence</dt>
          <dd data-testid="about-licence">
            <a
              href={docsUrl('LICENSE')}
              target="_blank"
              rel="noopener noreferrer"
              className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Apache License 2.0
            </a>
            <span className="text-fg-muted">
              {' '}
              · components under other licences:{' '}
              <a
                href={docsUrl('THIRD_PARTY_NOTICES.md')}
                target="_blank"
                rel="noopener noreferrer"
                className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                THIRD_PARTY_NOTICES.md
              </a>
            </span>
          </dd>
        </dl>
        {/* A source build reports the package version; an install reports its
            image tag, which may be written with a leading "v". */}
        {installed !== undefined && installed.replace(/^v/, '') !== accuracy.release && (
          <p className="mt-2 text-xs text-fg-muted" data-testid="about-version-note">
            The installed version is named by the install&rsquo;s image tag; the numbers below were
            published with the code of release {accuracy.release} that this page ships in.
          </p>
        )}
      </WidgetFrame>

      <WidgetFrame
        title="Published accuracy for this release"
        state="ready"
        testId="about-accuracy"
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg-muted">
            Measured {accuracy.measured.date} at commit <code className="font-mono">{commit}</code>{' '}
            with {accuracy.measured.engine} (tool adapters: {accuracy.measured.adapters}).{' '}
            {accuracy.scope}
          </p>
          <p className="text-xs text-fg-muted">
            <strong>Precision</strong> is the share of findings that were real (TP ÷ (TP + FP)).{' '}
            <strong>Recall</strong> is the share of real defects found (TP ÷ (TP + FN)). Low rows
            stay in the table: leaving them out would turn a measurement into marketing.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="about-accuracy-table">
              <caption className="sr-only">Precision and recall per benchmark suite</caption>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th scope="col" className="pr-3 pb-1">
                    Suite
                  </th>
                  <th scope="col" className="pr-3 pb-1 text-right">
                    Precision
                  </th>
                  <th scope="col" className="pr-3 pb-1 text-right">
                    Recall
                  </th>
                  <th scope="col" className="pr-3 pb-1 text-right">
                    TP / FP / FN
                  </th>
                  <th scope="col" className="pb-1">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody>
                {accuracy.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-border align-top"
                    data-testid={`about-row-${row.id}`}
                  >
                    <th scope="row" className="py-1 pr-3 text-left font-normal">
                      {row.label}
                      <span className="block text-xs text-fg-muted">
                        {KIND_WORDS[row.kind]} · {row.labels.toLocaleString('en-US')} labelled cases
                      </span>
                    </th>
                    <td className="py-1 pr-3 text-right tabular-nums">{percent(row.precision)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{percent(row.recall)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums text-fg-muted">
                      {row.tp} / {row.fp} / {row.fn}
                    </td>
                    <td className="py-1 text-xs text-fg-muted">
                      <code className="font-mono">{accuracy.source}</code>, {row.from}
                    </td>
                  </tr>
                ))}
                <tr
                  className="border-t border-border-strong align-top"
                  data-testid="about-row-total"
                >
                  <th scope="row" className="py-1 pr-3 text-left font-medium">
                    {accuracy.total.label}
                  </th>
                  <td className="py-1 pr-3 text-right font-medium tabular-nums">
                    {percent(accuracy.total.precision)}
                  </td>
                  <td className="py-1 pr-3 text-right font-medium tabular-nums">
                    {percent(accuracy.total.recall)}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums text-fg-muted">
                    {accuracy.total.tp} / {accuracy.total.fp} / {accuracy.total.fn}
                  </td>
                  <td className="py-1 text-xs text-fg-muted">
                    <code className="font-mono">{accuracy.source}</code>, {accuracy.total.from}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {accuracy.notShown.map((n) => (
            <p key={n.id} className="text-xs text-fg-muted">
              Not listed: <code className="font-mono">{n.id}</code>. {n.reason}
            </p>
          ))}
          <p className="text-xs text-fg-muted" data-testid="about-previous">
            {accuracy.previous
              ? `Previous release (${accuracy.previous.release}) measured ${accuracy.previous.measured.date}.`
              : 'This is the first release with published numbers, so there is no earlier release to compare with.'}
          </p>
          <p className="text-xs text-fg-muted">
            How the numbers were produced, what they do not cover, and the per-weakness tables are
            in <code className="font-mono">{accuracy.method}</code> in the RepoPulse source.
          </p>
        </div>
      </WidgetFrame>
    </div>
  );
}
