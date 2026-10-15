// AI-authorship pattern list (W18-20). Editable by a workspace admin and stored
// in workspaces.settings under AI_AUTHORSHIP_SETTINGS_KEY.
//
// PRECISION OVER RECALL. A change wrongly called AI-authored moves a number a
// leader will quote ("a third of our code is AI"), so every default is a
// marker an agent writes on purpose: a no-reply address in a co-author
// trailer, an agent's bot account, a branch prefix an agent creates. A bare
// name is NOT a default — "Co-authored-by: Claude Martin <claude@acme.io>" is a
// person. An admin who knows their team can add looser patterns.
//
// Sources for the defaults (checked 2026-10): Claude Code writes
// "Co-Authored-By: <model> <noreply@anthropic.com>"; Cursor's agent writes
// "Co-authored-by: Cursor <cursoragent@cursor.com>"; Codex wrote
// "Co-authored-by: Codex <noreply@openai.com>"; the GitHub Copilot coding agent
// opens PRs as `Copilot` / `copilot-swe-agent[bot]` on `copilot/` branches and
// co-authors as `<id>+Copilot@users.noreply.github.com`; Devin works as
// `devin-ai-integration[bot]`; aider attributes to `noreply@aider.chat`.

export interface AiAuthorshipPatterns {
  /**
   * Case-insensitive substrings of a trailer VALUE ("Name <email>"). Only the
   * trailer keys in AI_TRAILER_KEYS are tested — a Signed-off-by naming an
   * agent's address is a sign-off, not authorship.
   */
  trailerPatterns: string[];
  /** Author-login globs (a single `*` wildcard anywhere), case-insensitive. */
  botLogins: string[];
  /** Case-insensitive source-branch prefixes, e.g. `claude/`. */
  branchPrefixes: string[];
}

/** The settings key, snake_case like every other workspaces.settings key. */
export const AI_AUTHORSHIP_SETTINGS_KEY = 'ai_authorship_patterns';

/**
 * Trailer keys that ASSERT authorship. Fixed rather than editable: the value
 * patterns are where teams differ, and a key list an admin could empty would
 * silently switch the most reliable signal off.
 */
export const AI_TRAILER_KEYS: readonly string[] = [
  'co-authored-by',
  // The Linux kernel's 2025 AI policy and several agents use these instead.
  'assisted-by',
  'generated-by',
];

export const DEFAULT_AI_AUTHORSHIP_PATTERNS: AiAuthorshipPatterns = {
  trailerPatterns: [
    'noreply@anthropic.com',
    'cursoragent@cursor.com',
    'noreply@openai.com',
    '+copilot@users.noreply.github.com',
    'devin-ai-integration',
    'noreply@aider.chat',
  ],
  botLogins: [
    'Copilot',
    'copilot-swe-agent*',
    'claude[bot]',
    'cursor[bot]',
    'devin-ai-integration*',
    'chatgpt-codex-connector*',
    'google-labs-jules*',
    'openhands-agent*',
  ],
  branchPrefixes: [
    'claude/',
    'copilot/',
    'cursor/',
    'devin/',
    'codex/',
    'jules/',
    'aider/',
    'openhands/',
  ],
};

/** Bounds an admin edit: these lists are matched against every change in a window. */
export const AI_PATTERN_LIMITS = { maxPerList: 100, maxLength: 200 } as const;

function cleanList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > AI_PATTERN_LIMITS.maxLength) return null;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out.length > AI_PATTERN_LIMITS.maxPerList ? null : out;
}

/**
 * The patterns in effect for a stored settings object.
 *
 * Per-list fallback, and `[]` is honoured: an admin who empties the branch list
 * has decided branch names mean nothing on their forge, and handing the
 * defaults back would undo that silently. A malformed list (hand-edited SQL)
 * falls back to its default rather than throwing — a bad setting must not take
 * the report down.
 */
export function resolveAiAuthorshipPatterns(settings: unknown): AiAuthorshipPatterns {
  const stored =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)[AI_AUTHORSHIP_SETTINGS_KEY]
      : undefined;
  const obj = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  return {
    trailerPatterns:
      cleanList(obj.trailer_patterns) ?? DEFAULT_AI_AUTHORSHIP_PATTERNS.trailerPatterns,
    botLogins: cleanList(obj.bot_logins) ?? DEFAULT_AI_AUTHORSHIP_PATTERNS.botLogins,
    branchPrefixes: cleanList(obj.branch_prefixes) ?? DEFAULT_AI_AUTHORSHIP_PATTERNS.branchPrefixes,
  };
}

/**
 * A short, stable fingerprint of a pattern set, printed with the report so two
 * reports over the same window can be told apart when an admin changed the
 * list in between (the classification is computed on read, not stored).
 */
export function patternsFingerprint(p: AiAuthorshipPatterns): string {
  const text = JSON.stringify([p.trailerPatterns, p.botLogins, p.branchPrefixes]);
  // FNV-1a: deterministic and dependency-free; this is a label, not security.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
