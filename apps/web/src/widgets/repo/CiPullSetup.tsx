import { WidgetFrame } from '../../components/index.js';
import { docsUrl } from '../../lib/docs.js';
import { InternalLink } from '../plans/InternalLink.js';

// Repo → CI → "Gate pull requests on RepoPulse findings" (W20-08, UX_TODO FND-17).
//
// The CI pull (D16) was documented in CI_INTEGRATION.md and reachable from
// nowhere in the product. This panel gives the two steps: mint a token for
// this repository in Settings → CI tokens, then run the CLI in the pipeline.

/** The pipeline step, with this repository's id filled in. Exported for the test. */
export function ciSnippet(repoId: string, origin: string): string {
  return [
    `export REPOPULSE_SERVER=${origin}`,
    `curl -fsS -H "Authorization: Bearer $REPOPULSE_TOKEN" \\`,
    `  "$REPOPULSE_SERVER/api/v1/cli/repopulse.mjs" -o repopulse.mjs`,
    `node repopulse.mjs check --repo ${repoId} --pr "$PR_NUMBER" --sha "$HEAD_SHA" --wait 600 \\`,
    `  --fail-on high --sarif repopulse.sarif --markdown repopulse.md`,
  ].join('\n');
}

export function CiPullSetup({ repoId }: { repoId: string }) {
  const origin =
    typeof window === 'undefined' ? 'https://repopulse.example' : window.location.origin;
  return (
    <WidgetFrame
      title="Gate pull requests on RepoPulse findings"
      state="ready"
      testId="ci-pull-setup"
    >
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>
          Create a CI token that reads this repository in{' '}
          <InternalLink
            to="/admin/ci-tokens"
            className="text-accent hover:underline"
            testId="ci-pull-tokens-link"
          >
            Settings → CI tokens
          </InternalLink>{' '}
          (admin), and store it as the CI secret <code className="font-mono">REPOPULSE_TOKEN</code>.
        </li>
        <li>
          Add this step to the pipeline that runs on pull requests:
          <pre
            className="mt-1 overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-xs"
            data-testid="ci-pull-snippet"
          >
            {ciSnippet(repoId, origin)}
          </pre>
        </li>
      </ol>
      <p className="mt-2 text-xs text-fg-muted">
        Thresholds, SARIF and PR-comment output are in{' '}
        <a
          href={docsUrl('/docs/CI_INTEGRATION.md')}
          className="text-accent hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          the CI integration guide
        </a>
        .
      </p>
    </WidgetFrame>
  );
}
