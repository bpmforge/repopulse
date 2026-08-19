import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rulepack loading (W8-04, SECURITY_SUITE.md 3.1).
//
// The loader below reads a STRICT SUBSET of YAML - the shape this rulepack
// actually uses - rather than pulling in a YAML implementation, for the same
// reason the tar reader is hand-owned: the rulepack decides what counts as a
// leaked credential, so the code that decides whether a rule was understood
// should be code we can read.
//
// It FAILS CLOSED. Any line it cannot account for throws, because the
// alternative is a detector that silently vanishes from the pack - and a
// missing detector produces exactly the same output as a clean repository.

export interface SecretRule {
  id: string;
  description: string;
  /** Credential family, used for `yields: credential:{kind}` in chaining. */
  kind: string;
  severity: number;
  regex: RegExp;
  /** Cheap pre-filter: skip the regex entirely unless a keyword is present. */
  keywords: string[];
  /** Minimum Shannon entropy of the captured value, when the rule sets one. */
  entropy?: number;
  /** Matches that are known non-secrets (placeholders, other rules' prefixes). */
  allowlist: RegExp[];
}

export interface Rulepack {
  version: number;
  /** Stamped on every finding and scan_run: a finding is only reproducible
   *  against the pack that produced it. */
  versionTag: string;
  rules: SecretRule[];
}

export class RulepackError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = 'RulepackError';
  }
}

type Scalar = string | number;

function stripQuotes(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" || first === '"') && last === first) {
      const inner = value.slice(1, -1);
      // Only single quotes get YAML's doubled-quote escape; a double-quoted
      // scalar in this pack never needs one, and pretending to implement
      // backslash escapes would be the kind of half-support that silently
      // mangles a regex.
      return first === "'" ? inner.replace(/''/g, "'") : inner;
    }
  }
  return value;
}

function parseScalar(raw: string): Scalar {
  const value = stripQuotes(raw);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

interface RawRule {
  [key: string]: Scalar | string[];
}

/**
 * Parses the subset: `version: N`, `rules:` and a list of maps whose values are
 * scalars or lists of scalars. Comments and blank lines are skipped.
 */
export function parseRulepackYaml(text: string): { version: number; rules: RawRule[] } {
  let version: number | undefined;
  const rules: RawRule[] = [];
  let current: RawRule | undefined;
  let listKey: string | undefined;
  let inRules = false;
  // Indentation of the rules sequence, learned from its first `- ` line. It is
  // what separates a NEW RULE from a list item: keying that decision on
  // "is a list open?" instead put every rule after a keywords block into the
  // previous rule's keyword list, and the pack silently lost half its
  // detectors while still loading.
  let sequenceIndent: number | undefined;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
      if (!match) throw new RulepackError(`unrecognised top-level line: ${body}`, lineNo);
      const [, key, value] = match;
      if (key === 'version') version = Number(parseScalar(value as string));
      else if (key === 'rules') inRules = true;
      else throw new RulepackError(`unknown top-level key "${key}"`, lineNo);
      continue;
    }

    if (!inRules) throw new RulepackError(`indented line outside rules: ${body}`, lineNo);

    if (body.startsWith('- ')) sequenceIndent ??= indent;

    if (body.startsWith('- ') && indent === sequenceIndent) {
      // New rule in the sequence.
      current = {};
      rules.push(current);
      listKey = undefined;
      const inner = body.slice(2);
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(inner);
      if (!match) throw new RulepackError(`rule item is not a key: ${inner}`, lineNo);
      const [, key, value] = match;
      if ((value as string).trim() === '') listKey = key as string;
      else current[key as string] = parseScalar(value as string);
      continue;
    }

    if (body.startsWith('- ')) {
      if (!current || !listKey) throw new RulepackError(`list item with no key: ${body}`, lineNo);
      const list = (current[listKey] as string[] | undefined) ?? [];
      list.push(String(stripQuotes(body.slice(2))));
      current[listKey] = list;
      continue;
    }

    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
    if (!match) throw new RulepackError(`unrecognised line: ${body}`, lineNo);
    const [, key, value] = match;
    if (!current) throw new RulepackError(`key outside a rule: ${body}`, lineNo);
    if ((value as string).trim() === '') {
      listKey = key as string;
      current[key as string] = [];
    } else {
      listKey = undefined;
      current[key as string] = parseScalar(value as string);
    }
  }

  if (version === undefined) throw new RulepackError('rulepack has no version');
  if (rules.length === 0) throw new RulepackError('rulepack has no rules');
  return { version, rules };
}

/**
 * Compiles a pattern written for Go's regexp, which JavaScript's RegExp is not.
 *
 * The only difference this pack uses is the inline `(?i)` flag. Translating it
 * keeps rules portable in both directions; dropping it silently would quietly
 * narrow every assignment rule to lower-case only - a rule that still fires,
 * just less often, which is the hardest kind of bug to notice in a scanner.
 */
function toRegExp(source: string, flags: string): RegExp {
  const caseInsensitive = source.startsWith('(?i)');
  return new RegExp(caseInsensitive ? source.slice(4) : source, caseInsensitive ? flags + 'i' : flags);
}

const REQUIRED = ['id', 'description', 'kind', 'severity', 'regex'] as const;
const KNOWN = new Set([...REQUIRED, 'keywords', 'entropy', 'allowlist']);

export function compileRulepack(parsed: { version: number; rules: RawRule[] }): Rulepack {
  const seen = new Set<string>();
  const rules = parsed.rules.map((raw) => {
    for (const key of Object.keys(raw)) {
      // An unknown key is a typo in a security rule - `entropu: 4.2` would
      // otherwise mean "no entropy floor at all" and nobody would notice until
      // the alert volume changed.
      if (!KNOWN.has(key as never)) throw new RulepackError(`unknown rule field "${key}"`);
    }
    for (const key of REQUIRED) {
      if (raw[key] === undefined) throw new RulepackError(`rule is missing "${key}"`);
    }
    const id = String(raw['id']);
    if (seen.has(id)) throw new RulepackError(`duplicate rule id "${id}"`);
    seen.add(id);

    const severity = Number(raw['severity']);
    if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
      throw new RulepackError(`rule "${id}" has severity ${String(raw['severity'])}, expected 1-5`);
    }

    let regex: RegExp;
    try {
      regex = toRegExp(String(raw['regex']), 'g');
    } catch (err) {
      throw new RulepackError(`rule "${id}" has an invalid regex: ${(err as Error).message}`);
    }

    const allowlist = ((raw['allowlist'] as string[] | undefined) ?? []).map((pattern) => {
      try {
        return toRegExp(pattern, '');
      } catch (err) {
        throw new RulepackError(`rule "${id}" allowlist: ${(err as Error).message}`);
      }
    });

    const rule: SecretRule = {
      id,
      description: String(raw['description']),
      kind: String(raw['kind']),
      severity,
      regex,
      keywords: (raw['keywords'] as string[] | undefined) ?? [],
      allowlist,
    };
    if (raw['entropy'] !== undefined) rule.entropy = Number(raw['entropy']);
    return rule;
  });

  return { version: parsed.version, versionTag: `secrets.v${parsed.version}`, rules };
}

export function loadRulepackFrom(file: string): Rulepack {
  return compileRulepack(parseRulepackYaml(readFileSync(file, 'utf8')));
}

export const RULEPACK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../rulepacks',
);

let cached: Rulepack | undefined;

/** The shipped pack. Cached: a regex set is compiled once per process. */
export function loadRulepack(): Rulepack {
  cached ??= loadRulepackFrom(path.join(RULEPACK_DIR, 'secrets.v1.yaml'));
  return cached;
}
