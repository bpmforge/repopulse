// SC-2 no-log rule: applied to the *entire serialized line* (pino's
// `hooks.streamWrite`), not just known object paths — a path-based redactor
// (e.g. pino's own `redact` option) only catches values at pre-declared
// paths and would miss a token embedded at an unanticipated depth or inside
// a free-text message. Two independent layers:
//   1. field-name-keyed: redacts the VALUE of any JSON key containing one
//      of the denylisted substrings, whatever the key's exact name or depth.
//   2. bare-pattern: scrubs token/PEM shapes wherever they appear, even
//      outside a denylisted key (e.g. accidentally interpolated into a
//      message string).

const DENYLIST_KEY_PATTERN =
  /"([a-zA-Z0-9_-]*(?:token|credential|secret|authorization|password|x-hub-signature)[a-zA-Z0-9_-]*)"\s*:\s*"((?:\\.|[^"\\])*)"/gi;

// GitHub token prefixes (ghp_/gho_/ghu_/ghs_/ghr_) per SC-2's exact regex.
const GITHUB_TOKEN_PATTERN = /gh[pous]_[A-Za-z0-9]{36,}/g;

// PEM blocks (GitHub App private keys) - matches both raw newlines and the
// `\n`-escaped form that appears inside a JSON-stringified log line.
const PEM_BLOCK_PATTERN = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

// A drizzle query failure's text (drizzle-orm >= 0.44): "Failed query: <sql>
// \nparams: <bound values>". In a JSON line the newline is the escaped `\n`.
// Runs up to the end of the JSON string or the first stack frame, whichever
// comes first. The structured form is handled before serialization (see the
// `formatters.log` hook in index.ts); this catches the same text when it
// arrives as a plain string.
const QUERY_FAILURE_PATTERN =
  /Failed query: (?:\\.|[^"\\])*?\\nparams: (?:\\.|[^"\\])*?(?=\\n {4}at |")/g;

export function redactLine(line: string): string {
  return line
    .replace(QUERY_FAILURE_PATTERN, 'Failed query: [REDACTED-SQL]')
    .replace(DENYLIST_KEY_PATTERN, '"$1":"[REDACTED]"')
    .replace(GITHUB_TOKEN_PATTERN, '[REDACTED-TOKEN]')
    .replace(PEM_BLOCK_PATTERN, '[REDACTED-PEM]');
}
