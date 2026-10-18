import { createHash } from 'node:crypto';

// The responsibility statement for the customer-supplied Claude Code CLI option
// (W19-08, Brad 2026-10-17).
//
// An admin must read this, and accept THIS VERSION of it, before the option can
// be used at all. The accepted version and its SHA-256 are stored with who and
// when, so what a person agreed to is provable later and a reworded statement
// cannot be passed off as the one that was accepted.
//
// WHY IT EXISTS. The project has not verified that Anthropic's consumer plan
// terms allow this use. The statement does not pretend otherwise: it makes the
// responsibility explicit, keeps the default off, and points at the supported
// route (an API key).

export const CLAUDE_CLI_STATEMENT_VERSION = 'claude-cli.v1';

export const CLAUDE_CLI_STATEMENT_TITLE = 'Using your own Claude Code CLI with RepoPulse';

export const CLAUDE_CLI_STATEMENT_POINTS: readonly { heading: string; text: string }[] = [
  {
    heading: 'This is customer-supplied, not a RepoPulse feature.',
    text: 'You install the Claude Code CLI and sign in to it yourself, inside your own RepoPulse container. RepoPulse runs your CLI as a program, the way you could from a shell. RepoPulse does not provide, license or vouch for it.',
  },
  {
    heading: "You are responsible for your plan's terms.",
    text: "Whether your Claude plan (for example Pro or Max) allows using the CLI this way, including running it automatically and on your organisation's code, is governed by Anthropic's terms and usage policies for your plan. The makers of RepoPulse have not verified that those terms permit it. If they do not, or they change, that responsibility is yours.",
  },
  {
    heading: 'RepoPulse does not store or transmit your login.',
    text: "Your login stays in the CLI's own configuration in your container. RepoPulse never reads, saves, logs or sends it anywhere. It asks you for no password or key, and this option accepts none.",
  },
  {
    heading: 'Your code goes to Anthropic.',
    text: 'Each call sends diffs, pull-request descriptions and file paths to Anthropic through your CLI. RepoPulse records every call in the egress audit. The "Local only" switch refuses this option.',
  },
  {
    heading: 'It can stop working.',
    text: "Anthropic may limit, change or stop this at any time, and your plan may rate-limit it. When it fails, RepoPulse says so plainly and moves to the next connection in the role's fallback chain, if there is one.",
  },
  {
    heading: 'API keys remain the supported route.',
    text: 'If you want a supported, metered arrangement, use the Anthropic API-key provider instead.',
  },
  {
    heading: 'It is off until you accept, and you can switch it off.',
    text: 'Accepting is recorded with your name, the time and the exact version of this statement. Any admin can revoke it; connections that use it then stop and say why.',
  },
];

/** The text as one string - what is hashed, so the hash covers every word shown. */
export function claudeCliStatementText(): string {
  return [
    CLAUDE_CLI_STATEMENT_TITLE,
    '',
    ...CLAUDE_CLI_STATEMENT_POINTS.map((p, i) => `${i + 1}. ${p.heading} ${p.text}`),
  ].join('\n');
}

export const CLAUDE_CLI_STATEMENT_SHA256 = createHash('sha256')
  .update(claudeCliStatementText())
  .digest('hex');
