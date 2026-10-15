import { isBotLogin } from './bots.js';

// The AI review bots RepoPulse can attribute activity to (W18-23, METRICS.md
// §5). Matched by exact login, case-insensitively — a substring or glob match
// on a word like "copilot" would sweep up a person whose handle contains it,
// and attributing a human's review to a tool is the one error this screen
// must not make.
//
// Two of these do not end in `[bot]` and so escape METRICS.md §0's default
// globs: GitHub reports Copilot's reviews as `Copilot` in some payloads and
// `copilot-pull-request-reviewer` in GraphQL, and a self-hosted CodeRabbit on
// Gitea/GitLab runs as an ordinary `coderabbitai` user. That is why
// isNonHumanReviewer() below consults this list as well as the globs: without
// it, a Copilot review would count as the human first review in M4 and as
// human review coverage in M5.
export interface KnownReviewBot {
  /** Stable id used in API payloads and URLs. */
  key: string;
  /** The product name a person would recognise. */
  name: string;
  logins: readonly string[];
}

export const KNOWN_REVIEW_BOTS: readonly KnownReviewBot[] = [
  { key: 'coderabbit', name: 'CodeRabbit', logins: ['coderabbitai[bot]', 'coderabbitai'] },
  {
    key: 'copilot',
    name: 'Copilot code review',
    logins: ['copilot-pull-request-reviewer[bot]', 'copilot-pull-request-reviewer', 'Copilot'],
  },
  {
    key: 'qodo',
    name: 'Qodo Merge',
    logins: [
      'qodo-merge-pro[bot]',
      'qodo-merge[bot]',
      'qodo-code-review[bot]',
      'codiumai-pr-agent-pro[bot]',
    ],
  },
  { key: 'greptile', name: 'Greptile', logins: ['greptile-apps[bot]'] },
  { key: 'bugbot', name: 'Cursor BugBot', logins: ['cursor[bot]'] },
];

const BY_LOGIN = new Map<string, KnownReviewBot>(
  KNOWN_REVIEW_BOTS.flatMap((bot) => bot.logins.map((l) => [l.toLowerCase(), bot] as const)),
);

/** The review bot a login belongs to, or null for anyone else. */
export function reviewBotForLogin(login: string): KnownReviewBot | null {
  return BY_LOGIN.get(login.toLowerCase()) ?? null;
}

/**
 * METRICS.md §0 for review activity: true when a review or review comment must
 * stay out of every human-flow metric.
 *
 * Three independent sources, any one sufficient: the identity row's own flag
 * (set at ingest, and editable by an admin), the workspace's bot globs, and the
 * known review bots — which a workspace that replaced the default globs with
 * its own list would otherwise lose.
 */
export function isNonHumanReviewer(
  login: string,
  botGlobs?: readonly string[],
  identityIsBot = false,
): boolean {
  return identityIsBot || isBotLogin(login, botGlobs) || reviewBotForLogin(login) !== null;
}
