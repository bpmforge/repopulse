import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_LOGIN_GLOBS } from '../engine/bots.js';
import type { ChurnFileTouch } from '../metrics/churn.js';
import { computeRework14d } from '../metrics/debt.js';
import { classifyCommit, classifyPr, hasAiTrailer, prNumberFromSubject } from './classify.js';
import {
  AI_AUTHORSHIP_SETTINGS_KEY,
  DEFAULT_AI_AUTHORSHIP_PATTERNS,
  patternsFingerprint,
  resolveAiAuthorshipPatterns,
} from './patterns.js';
import { parseCommitTrailers } from './trailers.js';
import {
  computeRepoGovernance,
  governanceSentence,
  mergeGovernanceTotals,
  summarizeGovernance,
  type GovCommit,
  type GovPr,
  type RepoGovernanceInputs,
} from './governance.js';

const P = DEFAULT_AI_AUTHORSHIP_PATTERNS;
const BOTS = DEFAULT_BOT_LOGIN_GLOBS;

describe('parseCommitTrailers (W18-20)', () => {
  it('reads the last paragraph as trailers', () => {
    expect(
      parseCommitTrailers(
        'Fix the thing\n\nLonger body.\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>\nSigned-off-by: Ann <ann@x.io>',
      ),
    ).toEqual([
      'Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>',
      'Signed-off-by: Ann <ann@x.io>',
    ]);
  });

  it('a subject alone has no trailers, even when it looks like one', () => {
    expect(parseCommitTrailers('Co-authored-by: Cursor <cursoragent@cursor.com>')).toEqual([]);
  });

  it('a prose last paragraph is not a trailer block (one non-trailer line disqualifies it)', () => {
    expect(
      parseCommitTrailers(
        'Subject\n\nThanks to the team.\nCo-authored-by: Codex <noreply@openai.com>',
      ),
    ).toEqual([]);
  });

  it('folds continuation lines and handles CRLF', () => {
    expect(parseCommitTrailers('S\r\n\r\nNote: one\r\n  two')).toEqual(['Note: one two']);
  });
});

describe('classifier (W18-20)', () => {
  it('a co-author trailer with an agent address is AI; a human called Claude is not', () => {
    expect(hasAiTrailer(['Co-authored-by: Claude <noreply@anthropic.com>'], P)).toBe(true);
    expect(hasAiTrailer(['Co-authored-by: Claude Martin <claude@acme.io>'], P)).toBe(false);
  });

  it('only authorship trailer keys count — a sign-off naming an agent address is not authorship', () => {
    expect(hasAiTrailer(['Signed-off-by: Bot <noreply@anthropic.com>'], P)).toBe(false);
    expect(hasAiTrailer(['Assisted-by: Cursor <cursoragent@cursor.com>'], P)).toBe(true);
  });

  it('agent bots are AI even though *[bot] would call them automation; dependabot stays automation', () => {
    const base = { trailers: [] as string[] };
    expect(classifyCommit({ ...base, authorLogin: 'claude[bot]' }, P, BOTS)).toEqual({
      authorship: 'ai',
      signal: 'bot_author',
    });
    expect(classifyCommit({ ...base, authorLogin: 'dependabot[bot]' }, P, BOTS).authorship).toBe(
      'automation',
    );
    expect(classifyCommit({ ...base, authorLogin: 'ann' }, P, BOTS).authorship).toBe('human');
  });

  it('a commit ingested before 0035 (trailers NULL) is unknown, not human', () => {
    expect(classifyCommit({ authorLogin: 'ann', trailers: null }, P, BOTS).authorship).toBe(
      'unknown',
    );
  });

  it('PR branch prefixes match case-insensitively at the start only', () => {
    const pr = { authorLogin: 'ann', isBot: false };
    expect(classifyPr({ ...pr, headRef: 'Claude/fix-x' }, P, BOTS).signal).toBe('branch_prefix');
    expect(classifyPr({ ...pr, headRef: 'feature/claude/fix' }, P, BOTS).authorship).toBe('human');
    expect(classifyPr({ ...pr, headRef: null }, P, BOTS).authorship).toBe('unknown');
    expect(classifyPr({ authorLogin: 'Copilot', isBot: false, headRef: 'x' }, P, BOTS).signal).toBe(
      'bot_author',
    );
  });

  it('reads the squash suffix only at the end of a subject', () => {
    expect(prNumberFromSubject('Fix login (#42)')).toBe(42);
    expect(prNumberFromSubject('Revert (#42) partially')).toBeNull();
  });
});

describe('pattern settings (W18-20)', () => {
  it('absent = defaults; [] is honoured; malformed falls back per list', () => {
    expect(resolveAiAuthorshipPatterns({})).toEqual(P);
    const r = resolveAiAuthorshipPatterns({
      [AI_AUTHORSHIP_SETTINGS_KEY]: {
        branch_prefixes: [],
        bot_logins: [3],
        trailer_patterns: ['x'],
      },
    });
    expect(r.branchPrefixes).toEqual([]);
    expect(r.botLogins).toEqual(P.botLogins);
    expect(r.trailerPatterns).toEqual(['x']);
  });

  it('the fingerprint changes when the list does', () => {
    expect(patternsFingerprint(P)).toBe(patternsFingerprint({ ...P }));
    expect(patternsFingerprint(P)).not.toBe(patternsFingerprint({ ...P, branchPrefixes: [] }));
  });
});

// --- governance -----------------------------------------------------------------

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const at = (d: number) => new Date(T0 + d * DAY).toISOString();

function touch(sha: string, path: string, day: number, lines = 10): ChurnFileTouch {
  return {
    sha,
    authorLogin: 'x',
    parentShaCount: 1,
    superseded: false,
    path,
    additions: lines,
    deletions: 0,
    touchedAt: at(day),
  };
}

function commit(sha: string, over: Partial<GovCommit> = {}): GovCommit {
  return {
    sha,
    authorLogin: 'ann',
    trailers: [],
    messageHead: 'change',
    isMerge: false,
    isRevertHeuristic: false,
    ...over,
  };
}

function inputs(over: Partial<RepoGovernanceInputs>): RepoGovernanceInputs {
  return {
    commits: [],
    prs: [],
    touches: [],
    reviewPrs: [],
    findings: [],
    findingsMeasured: true,
    ...over,
  };
}

const AI_TRAILER = ['Co-authored-by: Claude <noreply@anthropic.com>'];

describe('computeRepoGovernance (W18-20)', () => {
  it('M13 slice is attributed over the full history: an AI change redoing a human change counts as AI rework', () => {
    const touches = [touch('h1', 'a.ts', 0), touch('ai1', 'a.ts', 3), touch('h2', 'b.ts', 1)];
    const t = computeRepoGovernance(
      inputs({
        commits: [commit('h1'), commit('ai1', { trailers: AI_TRAILER }), commit('h2')],
        touches,
      }),
      P,
      BOTS,
    );
    expect(t.ai.reworkLines).toBe(10);
    expect(t.human.reworkLines).toBe(0);
    // The slices reconcile with whole-repo M13.
    const whole = computeRework14d(touches);
    expect(t.ai.reworkLines + t.human.reworkLines).toBe(whole.reworkLines);
    expect(t.ai.linesChanged + t.human.linesChanged).toBe(whole.totalLines);
  });

  it('a claude/ branch PR makes its squash commit AI (linked_pr), and an AI-trailered squash makes its PR AI', () => {
    const prs: GovPr[] = [
      {
        id: 1,
        number: 7,
        authorLogin: 'ann',
        isBot: false,
        headRef: 'claude/x',
        headSha: 's',
        openedInWindow: true,
      },
      {
        id: 2,
        number: 8,
        authorLogin: 'bo',
        isBot: false,
        headRef: 'feat/y',
        headSha: 't',
        openedInWindow: true,
      },
    ];
    const t = computeRepoGovernance(
      inputs({
        prs,
        commits: [
          commit('c7', { messageHead: 'Do x (#7)' }),
          commit('c8', { messageHead: 'Do y (#8)', trailers: AI_TRAILER }),
        ],
      }),
      P,
      BOTS,
    );
    expect(t.ai.commits).toBe(2);
    expect(t.aiCommitSignals.linked_pr).toBe(1);
    expect(t.aiCommitSignals.trailer).toBe(1);
    expect(t.ai.prs).toBe(2);
    expect(t.aiPrSignals).toMatchObject({ branch_prefix: 1, linked_commit: 1 });
  });

  it('merges, automation and unknown rows are in no cohort; reverts follow M14', () => {
    const t = computeRepoGovernance(
      inputs({
        commits: [
          commit('m', { isMerge: true }),
          commit('d', { authorLogin: 'dependabot[bot]' }),
          commit('old', { trailers: null }),
          commit('r', { isRevertHeuristic: true, trailers: AI_TRAILER }),
          commit('h'),
        ],
      }),
      P,
      BOTS,
    );
    expect(t.automation.commits).toBe(1);
    expect(t.unknown.commits).toBe(1);
    expect(t.ai).toMatchObject({ commits: 1, reverts: 1, revertEligibleCommits: 1 });
    expect(t.human).toMatchObject({ commits: 1, reverts: 0, revertEligibleCommits: 1 });
  });

  it('review depth keeps agent-opened PRs (M5 would drop them as bots) and counts non-author reviews', () => {
    const prs: GovPr[] = [
      {
        id: 1,
        number: 1,
        authorLogin: 'copilot-swe-agent[bot]',
        isBot: true,
        headRef: 'copilot/a',
        headSha: 'a',
        openedInWindow: true,
      },
    ];
    const t = computeRepoGovernance(
      inputs({
        prs,
        reviewPrs: [
          {
            number: 1,
            authorLogin: 'copilot-swe-agent[bot]',
            isBot: true,
            mergedAt: at(1),
            mergedByLogin: null,
            additions: 1,
            deletions: 1,
            reviews: [
              { reviewerLogin: 'ann', state: 'APPROVED', hasContent: true },
              { reviewerLogin: 'bo', state: 'COMMENTED', hasContent: true },
              { reviewerLogin: 'ann', state: 'DISMISSED', hasContent: true },
            ],
          },
        ],
      }),
      P,
      BOTS,
    );
    expect(t.ai).toMatchObject({ mergedPrs: 1, reviewedPrs: 1, qualifyingReviews: 2 });
  });

  it('findings go to their PR, else to the last change of their file before first seen, else unattributed', () => {
    const prs: GovPr[] = [
      {
        id: 10,
        number: 3,
        authorLogin: 'ann',
        isBot: false,
        headRef: 'cursor/z',
        headSha: 'z',
        openedInWindow: true,
      },
    ];
    const t = computeRepoGovernance(
      inputs({
        prs,
        commits: [commit('h1'), commit('ai1', { trailers: AI_TRAILER })],
        touches: [touch('h1', 'a.ts', 0), touch('ai1', 'a.ts', 5)],
        findings: [
          { pullRequestId: 10, file: 'a.ts', firstSeenAt: at(1) },
          { pullRequestId: null, file: 'a.ts', firstSeenAt: at(2) }, // human touched it last
          { pullRequestId: null, file: 'a.ts', firstSeenAt: at(6) }, // AI touched it last
          { pullRequestId: null, file: null, firstSeenAt: at(6) },
        ],
      }),
      P,
      BOTS,
    );
    expect(t.ai.findings).toBe(2);
    expect(t.human.findings).toBe(1);
    expect(t.unattributedFindings).toBe(1);
  });
});

describe('summarizeGovernance (W18-20)', () => {
  it('says plainly when a sample is too small to compare, and never prints a direction for it', () => {
    const t = computeRepoGovernance(
      inputs({ commits: [commit('a', { trailers: AI_TRAILER }), commit('h')] }),
      P,
      BOTS,
    );
    const s = summarizeGovernance(t);
    expect(s.aiShareCommits).toBe(0.5);
    expect(s.anyComparable).toBe(false);
    const revert = s.measures.find((m) => m.key === 'revert_rate')!;
    expect(revert.direction).toBeNull();
    expect(revert.note).toMatch(/^Too small to compare: 1 AI-authored and 1 human commits/);
  });

  it('compares once both sides clear the minimum, with signal words only', () => {
    const commits: GovCommit[] = [];
    for (let i = 0; i < 25; i++) {
      commits.push(commit(`ai${i}`, { trailers: AI_TRAILER, isRevertHeuristic: i < 5 }));
      commits.push(commit(`h${i}`, { isRevertHeuristic: i < 1 }));
    }
    const s = summarizeGovernance(
      mergeGovernanceTotals([computeRepoGovernance(inputs({ commits }), P, BOTS)]),
    );
    const revert = s.measures.find((m) => m.key === 'revert_rate')!;
    expect(revert).toMatchObject({ comparable: true, direction: 'higher', ai: 0.2, human: 0.04 });
    const sentence = governanceSentence(revert);
    expect(sentence).toBe('Revert rate: higher for AI-authored changes (20.0% vs 4.0%).');
    expect(sentence).not.toMatch(/better|worse|grade/i);
  });

  it('findings are "not measured" when no pass ran, rather than zero', () => {
    const s = summarizeGovernance(
      computeRepoGovernance(inputs({ findingsMeasured: false }), P, BOTS),
    );
    const f = s.measures.find((m) => m.key === 'findings_per_kloc')!;
    expect(f.ai).toBeNull();
    expect(f.note).toMatch(/^Not measured/);
  });

  it('the summary carries no logins or trailer values (aggregate only, N-9)', () => {
    const s = summarizeGovernance(
      computeRepoGovernance(
        inputs({ commits: [commit('a', { authorLogin: 'zed-the-dev', trailers: AI_TRAILER })] }),
        P,
        BOTS,
      ),
    );
    const json = JSON.stringify(s);
    expect(json).not.toContain('zed-the-dev');
    expect(json).not.toContain('anthropic');
  });
});
