import { lex, type Lexed, type StringLit } from './leftovers-lex.js';

// Placeholder values in shipped code (W18-07, mechanical-checks plan §D).
//
// A generated integration arrives with the shape of working code and the
// values of a tutorial: `apiKey: 'YOUR_API_KEY'`, a client pointed at
// `https://api.example.com`, a default password of `changeme`. It compiles,
// it passes a test that mocks the network, and it fails — or worse, works
// with a guessable credential — in production.
//
// PRECISION OVER RECALL. Only string literals in CODE are read (comments and
// docstrings are where an example belongs), and only strings shaped like a
// value rather than a sentence: "Set YOUR_API_KEY in .env" is an instruction
// to a human, `'YOUR_API_KEY'` is a value nobody replaced. Paths that exist
// to hold examples — tests, docs, fixtures, samples, templates, stories — are
// not read at all.

export const PLACEHOLDER_RULE_ID = 'slop.placeholder_value';

export type PlaceholderKind =
  | 'your_placeholder'
  | 'angle_placeholder'
  | 'dummy_key'
  | 'example_endpoint'
  | 'lorem_ipsum'
  | 'replace_me'
  | 'weak_password';

export interface PlaceholderFinding {
  ruleId: typeof PLACEHOLDER_RULE_ID;
  file: string;
  line: number;
  kind: PlaceholderKind;
  /** The literal, quotes included — the evidence quote. */
  literal: string;
  message: string;
}

/**
 * Paths whose job is to hold examples, or that never ship.
 *
 * Deliberately broad: a placeholder in a seed script or a storybook story is
 * an example doing its job, and a rule that argues with those loses the
 * reader before it reaches the one in `src/client.ts`.
 */
export const NON_SHIPPED_PATH = new RegExp(
  [
    // `test-types/`, `unit_tests/`, `__tests__/`: any segment that says test.
    String.raw`(^|/)(?:[\w-]*[-_.])?(?:tests?|__tests__|specs?|testing|testdata)(?:[-_.][\w-]*)?/`,
    String.raw`(^|/)(e2e|cypress|playwright)/`,
    String.raw`(^|/)(fixtures?|__fixtures__|mocks?|__mocks__|stubs?|fakes?|seeds?|seeders?)/`,
    String.raw`(^|/)(examples?|samples?|demos?|docs?|documentation|tutorials?|playground|stories|storybook|\.storybook)/`,
    String.raw`(^|/)(templates?|scaffolds?|skeletons?|blueprints?|benchmarks?)/`,
    String.raw`\.(test|tst|spec|stories|story|e2e|bench|example|sample|template|tmpl|mock|fixture|fake)\.\w+$`,
    String.raw`(^|/)(test_[^/]*|[^/]*_test|conftest)\.py$`,
    String.raw`_test\.go$`,
    String.raw`(^|/)[^/]*Tests?\.(java|kt|cs)$`,
    String.raw`(^|/)README[^/]*$`,
    String.raw`\.(sample|example|dist)$`,
  ].join('|'),
  'i',
);

/** A value, not a sentence: no whitespace, bar an auth scheme prefix. */
function valueShaped(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  return /^\S+$/.test(value) || /^(?:Bearer|Token|Basic|Bot|ApiKey)\s+\S+$/i.test(value);
}

const NOT_ALNUM_BEFORE = '(?<![A-Za-z0-9])';
const NOT_ALNUM_AFTER = '(?![A-Za-z0-9])';

/** `YOUR_API_KEY`, `YOUR-CLIENT-ID`, `YOUR_TOKEN_HERE`. */
const YOUR_UPPER = new RegExp(`${NOT_ALNUM_BEFORE}YOUR[_-][A-Z0-9_-]*[A-Z0-9]${NOT_ALNUM_AFTER}`);

/** `your-api-key`, `your_secret_here`, `your-domain` — needs more support. */
const YOUR_LOWER = new RegExp(
  `${NOT_ALNUM_BEFORE}your[_-](?:[a-z0-9]+[_-]){0,3}?` +
    `(?:api[_-]?key|key|token|secret|password|passwd|client[_-]?id|client[_-]?secret|` +
    `account[_-]?id|project[_-]?id|app[_-]?id|tenant[_-]?id|id|url|domain|host|hostname|` +
    `server|bucket|username|user|email|webhook|endpoint|org|workspace)` +
    `(?:[_-]?here)?${NOT_ALNUM_AFTER}`,
);

/** `<your-api-key>`, `<YOUR TOKEN>`, `<insert key here>`, `<replace-me>`. */
const ANGLE = /<\s*(?:your|insert|enter|replace|put|paste|add)[\s_-][^<>]{1,48}>/i;

/** A whole value made of x's around a known key prefix. */
const DUMMY_KEY_PREFIXED =
  /^(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA|AIza|glpat|SG|key|api)[_-]?(?:(?:live|test|proj)[_-])?(?:x{6,}|X{6,})$/;
const DUMMY_KEY_BARE =
  /^(?:x{8,}|X{8,}|(?:x{3,}-){2,}x{3,}|(?:X{3,}-){2,}X{3,}|1234567890|0{16,})$/;

/** The code just before a string names a credential. */
const KEY_CONTEXT =
  /(?:api[_-]?key|apikey|key|token|secret|passw(?:or)?d|pwd|credential|auth(?:orization)?|bearer|signature|access[_-]?id)['"\]]?\s*(?:=>|[:=,(]|\|\||\?\?|\bor\b)\s*(?:[\w$.]+\s*(?:\|\||\?\?|\bor\b)\s*)?$/i;

const PASSWORD_CONTEXT =
  /(?:pass(?:word|wd|phrase)?|pwd)\w*['"\]]?\s*(?:=>|[:=,]|\|\||\?\?|\bor\b)\s*(?:[\w$.]+(?:\([^()]*\))?\s*(?:\|\||\?\?|\bor\b)\s*)?$/i;

/** Requires a digit or symbol suffix: a bare `password` is usually a field name. */
const WEAK_PASSWORD =
  /^(?:(?:password|passw0rd|p@ssw0rd|p@ssword|admin|letmein|qwerty|secret|root|changeit|welcome)(?:[!@#$]?\d{1,4}[!@#$]?|[!@#$])|passw0rd|p@ssw0rd|letmein|qwerty|changeit|hunter2|123456|1234567|12345678|123456789)$/i;

const REPLACE_ME = new RegExp(
  `${NOT_ALNUM_BEFORE}(?:change[_-]?me|change[_-]?this|replace[_-]?me|replace[_-]?this|todo[_-]?replace|fill[_-]?me[_-]?in|insert[_-]?here)${NOT_ALNUM_AFTER}`,
  'i',
);
const TODO_REPLACE = /^\s*TODO:?\s*(?:replace|change|fill in|set)\b/i;

const EXAMPLE_URL =
  /^(?:https?|wss?):\/\/(?:[\w-]+\.)*example\.(?:com|org|net)(?::\d+)?(?:[/?#]|$)/i;

/** The string is labelled as an example, or is an identifier rather than an endpoint. */
const EXAMPLE_LABEL_CONTEXT =
  /(?:placeholder|example|sample|hint|help|description|desc|docs?|title|label|tooltip|demo|\$?id|\$schema|xmlns|namespace|ns|issuer|audience|aud|iss)\w*['"\]]?\s*[:=](?![=>])/i;

/** `new URL(path, 'http://example.com')` — a dummy base for parsing a relative path. */
const URL_BASE_ARGUMENT = /\bURL\s*\([^()]*,\s*$/;
const URL_PARSE_CALL = /\b(?:URL|urljoin|urlparse|urlsplit|parse|resolve)\s*\(\s*$/;

function lineBefore(lexed: Lexed, s: StringLit): string {
  // Capped: on a minified line "the code before" is the whole bundle, and
  // every context this rule reads sits within a short reach of the string.
  const from = Math.max(lexed.lineStart(s.line), s.start - 160);
  return lexed.withStrings.slice(from, s.start);
}

function classify(lexed: Lexed, s: StringLit): PlaceholderKind | null {
  const v = s.value;
  const before = lineBefore(lexed, s);
  // A string that IS a key, a type or a comparand is the name of a
  // placeholder, not one in use: `kind: 'replace_me'`, `| 'changeme'`,
  // `if (secret === 'changeme') throw …` — the last one is the fix.
  const after = lexed.withStrings.slice(s.end, s.end + 3);
  if (/^\s*:(?!:)/.test(after) && !/\?\s*$/.test(before)) return null;
  if (
    // A single `|` is a union member; `||` is a fallback value, which counts.
    /(?:(?<!\|)\||[!=]==?|\bcase|\bin|\bnot in|\bis)\s*$/.test(before) ||
    /\btype\s+[\w$]+(?:<[^>]*>)?\s*=\s*$/.test(before) ||
    /^\s*(?:[!=]==?|\bin\b|\|(?!\|))/.test(after)
  )
    return null;

  if (/lorem ipsum dolor/i.test(v)) return 'lorem_ipsum';
  if (TODO_REPLACE.test(v)) return 'replace_me';
  if (ANGLE.test(v) && valueShaped(v.replace(ANGLE, 'X'))) return 'angle_placeholder';
  if (!valueShaped(v)) return null;

  if (YOUR_UPPER.test(v)) return 'your_placeholder';
  if (YOUR_LOWER.test(v)) {
    // Lower-case `your_email` is as often a form field name or a lookup key
    // as a value; it counts only as the whole value or as a URL's host.
    const whole = new RegExp(`^${YOUR_LOWER.source}$`).test(v);
    const host =
      /^[a-z]+:\/\/[^/]*your[_-]/i.test(v) || /^your[_-][\w-]*\.(?:com|org|net|io)\b/i.test(v);
    const lookup =
      /(?:\b(?:get|getenv|getItem|getattr|environ\.get|has|querySelector|getElementById)\s*\(|\[)\s*$/.test(
        before,
      );
    if ((whole || host) && !lookup) return 'your_placeholder';
  }
  if (REPLACE_ME.test(v)) {
    // `'replace_me'` in lower snake case is as often an enum tag as a value;
    // it needs a credential beside it to count.
    if (
      !/^[a-z]+(?:_[a-z]+)+$/.test(v) ||
      KEY_CONTEXT.test(before) ||
      PASSWORD_CONTEXT.test(before)
    )
      return 'replace_me';
  }
  if (DUMMY_KEY_PREFIXED.test(v)) return 'dummy_key';
  if (DUMMY_KEY_BARE.test(v) && KEY_CONTEXT.test(before)) return 'dummy_key';
  if (WEAK_PASSWORD.test(v) && PASSWORD_CONTEXT.test(before)) return 'weak_password';

  if (EXAMPLE_URL.test(v)) {
    if (EXAMPLE_LABEL_CONTEXT.test(before) || URL_BASE_ARGUMENT.test(before)) return null;
    // A bare origin handed to a parser is a dummy base, not a destination.
    if (/^[a-z]+:\/\/[^/]+\/?$/i.test(v) && URL_PARSE_CALL.test(before)) return null;
    return 'example_endpoint';
  }
  return null;
}

const MESSAGES: Record<PlaceholderKind, string> = {
  your_placeholder:
    'A "your-…" placeholder in shipped code: the value the integration needs was never filled in.',
  angle_placeholder:
    'An angle-bracket placeholder in shipped code: the value the integration needs was never filled in.',
  dummy_key:
    "A credential made of x's: a stand-in key that will fail at the first real request, or mask a missing configuration.",
  example_endpoint:
    'A URL on example.com/.org/.net used as a value: those domains are reserved for documentation (RFC 2606) and never answer as a real service.',
  lorem_ipsum: 'Lorem ipsum filler text in shipped code: placeholder copy that reaches users.',
  replace_me:
    'A "changeme"/"replace me" value in shipped code: a default somebody meant to replace, and an easy guess when nobody does.',
  weak_password:
    'A guessable password literal as a default: it works, which is the problem — nothing forces anyone to change it.',
};

export function placeholderValues(
  files: readonly { path: string; source: string }[],
): PlaceholderFinding[] {
  const out: PlaceholderFinding[] = [];
  for (const file of files) {
    if (NON_SHIPPED_PATH.test(file.path)) continue;
    const lexed = lex(file.path, file.source);
    if (!lexed) continue;
    // Python's `if __name__ == "__main__":` block is a module's demo — the
    // one place in a library file where example values are the point.
    const demo =
      lexed.family === 'hash'
        ? /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.exec(lexed.withStrings)
        : null;
    for (const s of lexed.strings) {
      if (s.docstring) continue;
      if (demo && s.start > demo.index) break;
      const kind = classify(lexed, s);
      if (!kind) continue;
      out.push({
        ruleId: PLACEHOLDER_RULE_ID,
        file: file.path,
        line: s.line,
        kind,
        literal: file.source.slice(s.start, s.end).slice(0, 200),
        message: MESSAGES[kind],
      });
    }
  }
  return out;
}
