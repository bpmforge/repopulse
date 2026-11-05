import { shannonEntropy } from './entropy.js';
import { loadRulepack, type Rulepack, type SecretRule } from './rulepack.js';

// Secret detection over a unified diff (W8-04, SECURITY_SUITE.md 3.1).
//
// ADDED LINES ONLY. A removed line containing a key is a key that was already
// committed - it belongs to history mode, which sweeps warehoused patches, and
// reporting it here would fire on every PR that deletes an old config and
// present a cleanup as a new leak.

export interface DiffPatchInput {
  path: string;
  patch: string | null;
}

export interface SecretMatch {
  ruleId: string;
  kind: string;
  severity: number;
  file: string;
  /** Line number in the NEW file, from the hunk header. */
  line: number;
  /** The matched credential. Never stored - hashed and discarded (SC-29). */
  secret: string;
  /** Shannon entropy of the match, for the operator's judgement. */
  entropy: number;
}

export { shannonEntropy } from './entropy.js';

export interface AddedLine {
  /** Line number in the new file. */
  line: number;
  text: string;
}

/**
 * Added lines of a unified diff, with their line numbers in the new file.
 *
 * The line number comes from the hunk header and is incremented per line,
 * because a finding whose location is off by the size of the hunk sends
 * someone to the wrong place - and in a secrets finding, the location is
 * ALL that gets stored.
 */
export function addedLines(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let lineNo = 0;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (lineNo === 0) continue; // preamble before the first hunk
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      out.push({ line: lineNo, text: raw.slice(1) });
      lineNo++;
      continue;
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue; // removed / "no newline"
    lineNo++; // context line
  }
  return out;
}

function allowed(rule: SecretRule, line: string, match: string): boolean {
  return rule.allowlist.some((pattern) => pattern.test(match) || pattern.test(line));
}

function keywordHit(rule: SecretRule, line: string): boolean {
  if (rule.keywords.length === 0) return true;
  const lower = line.toLowerCase();
  return rule.keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export interface ScanDiffOptions {
  rulepack?: Rulepack;
  /** Cap per file, so one generated blob cannot flood a PR's findings. */
  maxMatchesPerFile?: number;
}

/** Runs the rulepack over one file's patch. */
export function scanPatch(file: string, patch: string, opts: ScanDiffOptions = {}): SecretMatch[] {
  const pack = opts.rulepack ?? loadRulepack();
  const maxPerFile = opts.maxMatchesPerFile ?? 50;
  const matches: SecretMatch[] = [];
  // An imported rule (gitleaks) that finds the same secret on the same line as
  // one of our rules adds nothing but a duplicate finding: only what
  // our own rules miss is worth measuring it on. Imported hits are therefore
  // held back and added after this file's own hits.
  const ours = new Set<string>();
  const imported: (SecretMatch & { generic: boolean })[] = [];

  for (const { line, text } of addedLines(patch)) {
    for (const rule of pack.rules) {
      if (!keywordHit(rule, text)) continue;
      rule.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.regex.exec(text)) !== null) {
        // The capture group when the rule has one, the whole match otherwise:
        // an assignment rule matches `aws_secret_key = "..."` but only the
        // value is the credential, and hashing the assignment would give the
        // same secret a different fingerprint in a different file.
        const secret = rule.secretOf ? rule.secretOf(m) : (m[1] ?? m[0]);
        if (m[0].length === 0) break; // zero-width match: never advance forever
        if (rule.secretOf && secret.length === 0) continue;
        if (allowed(rule, text, secret)) continue;
        if (rule.keep && !rule.keep({ secret, match: m[0], line: text, file })) continue;
        const entropy = shannonEntropy(secret);
        if (rule.entropy !== undefined && entropy < rule.entropy) continue;
        const match: SecretMatch = {
          ruleId: rule.id,
          kind: rule.kind,
          severity: rule.severity,
          file,
          line,
          secret,
          entropy,
        };
        if (rule.secretOf) {
          imported.push({ ...match, generic: rule.yieldsToSpecific === true });
          continue;
        }
        ours.add(`${line}\u0000${secret}`);
        matches.push(match);
        if (matches.length >= maxPerFile) return matches;
      }
    }
  }
  const specific = [...matches, ...imported.filter((c) => !c.generic)];
  for (const { generic, ...c } of imported) {
    if (matches.length >= maxPerFile) break;
    if (ours.has(`${c.line}\u0000${c.secret}`)) continue;
    // gitleaks drops a generic hit that a specific rule also found on that line.
    if (
      generic &&
      specific.some(
        (o) => o.line === c.line && (o.secret.includes(c.secret) || c.secret.includes(o.secret)),
      )
    ) {
      continue;
    }
    matches.push(c);
  }
  return matches;
}

/** Runs the rulepack over every patch in a diff. Binary/absent patches skip. */
export function scanDiff(
  files: readonly DiffPatchInput[],
  opts: ScanDiffOptions = {},
): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    out.push(...scanPatch(file.path, file.patch, opts));
  }
  return out;
}
