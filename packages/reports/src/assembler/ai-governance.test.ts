import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_AUTHORSHIP_PATTERNS,
  DEFAULT_BOT_LOGIN_GLOBS,
  computeRepoGovernance,
  summarizeGovernance,
  type AiGovernanceResult,
  type GovCommit,
} from '@repopulse/metrics';
import { aiGovernanceSectionsFrom } from './ai-governance.js';

// W18-20: the report section. Signals not grades, no names, and a small sample
// said out loud rather than left for the reader to notice.

const AI = ['Co-authored-by: Claude <noreply@anthropic.com>'];
const commit = (sha: string, over: Partial<GovCommit> = {}): GovCommit => ({
  sha,
  authorLogin: 'pat-the-dev',
  trailers: [],
  messageHead: sha,
  isMerge: false,
  isRevertHeuristic: false,
  ...over,
});

function result(commits: GovCommit[], unknown = 0): AiGovernanceResult {
  const totals = computeRepoGovernance(
    { commits, prs: [], touches: [], reviewPrs: [], findings: [], findingsMeasured: false },
    DEFAULT_AI_AUTHORSHIP_PATTERNS,
    DEFAULT_BOT_LOGIN_GLOBS,
  );
  totals.unknown.commits += unknown;
  return {
    ...summarizeGovernance(totals),
    windowDays: 30,
    windowEnd: '2026-09-30T00:00:00.000Z',
    repoCount: 1,
    patternsFingerprint: 'deadbeef',
  };
}

describe('aiGovernanceSectionsFrom (W18-20)', () => {
  it('leads with "too small to compare" when no measure clears its minimum', () => {
    const [summary, table] = aiGovernanceSectionsFrom(
      result([commit('a', { trailers: AI }), commit('b')]),
    );
    expect(summary).toMatchObject({ kind: 'summary', id: 'ai_governance' });
    const md = summary!.kind === 'summary' ? summary!.markdown : '';
    expect(md).toContain('50.0% of commits');
    expect(md).toContain('too small to compare');
    expect(md).toContain('signals, not grades');
    expect(md).not.toMatch(/\b(better|worse)\b/i);
    expect(md).not.toContain('pat-the-dev');
    expect(table).toMatchObject({ kind: 'table', id: 'ai_governance_measures' });
    const rows = table!.kind === 'table' ? table!.rows : [];
    expect(rows.find((r) => r[0] === 'Revert rate')?.[4]).toMatch(/^Too small to compare/);
    expect(rows.find((r) => r[0] === 'Findings per 1,000 lines changed')?.[4]).toMatch(
      /^Not measured/,
    );
  });

  it('writes one direction sentence per comparable measure', () => {
    const commits: GovCommit[] = [];
    for (let i = 0; i < 25; i++) {
      commits.push(commit(`a${i}`, { trailers: AI, isRevertHeuristic: i < 5 }));
      commits.push(commit(`h${i}`, { isRevertHeuristic: i < 1 }));
    }
    const [summary] = aiGovernanceSectionsFrom(result(commits));
    const md = summary!.kind === 'summary' ? summary!.markdown : '';
    expect(md).toContain('Revert rate: higher for AI-authored changes (20.0% vs 4.0%).');
  });

  it('nothing classifiable is no_data that says why', () => {
    const [only] = aiGovernanceSectionsFrom(result([], 9));
    expect(only).toMatchObject({ kind: 'no_data', id: 'ai_governance' });
    expect(only!.kind === 'no_data' ? only!.reason : '').toContain(
      '9 commits were ingested before',
    );
  });
});
