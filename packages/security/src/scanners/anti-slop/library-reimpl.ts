import type { DeclaredDependency, DeclaredEcosystem } from '../../validation/declared.js';
import { normalizePackage } from './dep-categories.js';
import { NOT_A_PROJECT } from './duplicate-deps.js';
import { importsOf, lineAt, maskSource } from './source-graph.js';

// Library reimplementation (W18-06, mechanical-checks plan R-30).
//
// `function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); … } }`
// in a project whose package.json already lists lodash. The hand-rolled copy
// is the version without the edge cases — no `leading`/`trailing`, no
// `cancel`, a `this` that is wrong — written by an author who did not look at
// what the project already had.
//
// THREE THINGS MUST ALL BE TRUE, and each removes a known false positive:
//   1. the library is a DIRECT RUNTIME dependency of a project that contains
//      the file. A dev-only lodash cannot be imported by shipped code, and a
//      transitive one was never a choice — writing your own is then correct;
//   2. the body does the work itself: it holds the mechanism the API is made
//      of (a timer for debounce, randomness for a UUID, a loop with a catch for
//      retry). A body without it is a wrapper or something else of that name;
//   3. it does NOT delegate: the file does not import the library, and the
//      body calls nothing of the same name (`_.debounce`, `lodashDebounce`)
//      or the platform's own version (`crypto.randomUUID`). A thin wrapper
//      around the library is how teams pin options, and is fine.
//
// NOT COVERED, stated: Rust (its lifetime syntax `'a` defeats the shared
// masker, and a wrong mask is how a brace-matcher reads the next function as
// this one's body) and Kotlin.

export const LIBRARY_REIMPLEMENTATION_RULE_ID = 'slop.library_reimplementation';

type Language = 'js' | 'python' | 'go' | 'java';

interface ReimplEntry {
  ecosystem: DeclaredEcosystem;
  /** The API being re-written, as a reader would name it. */
  api: string;
  /** Packages that provide it; any one of them being declared is enough. */
  packages: readonly string[];
  /** Import prefixes that mean "this file uses the library". */
  modules: readonly string[];
  /** Function names, compared lowercase with `_` removed. */
  names: readonly string[];
  /** The mechanism a real implementation cannot do without. */
  does: (body: string) => boolean;
  /** Platform equivalents whose call makes the function a wrapper. */
  delegates?: RegExp;
}

const any =
  (...patterns: RegExp[]) =>
  (body: string): boolean =>
    patterns.some((p) => p.test(body));
const all =
  (...patterns: RegExp[]) =>
  (body: string): boolean =>
    patterns.every((p) => p.test(body));

const JS_TIMER = /\b(setTimeout|clearTimeout)\s*\(/;
const JS_WALK = /\b(for|while)\b|\.(map|reduce|forEach)\s*\(|Object\.(keys|entries|assign)\s*\(/;
const LODASH = ['lodash', 'lodash-es', 'es-toolkit', 'radash'];
const npm = (
  api: string,
  packages: string[],
  names: string[],
  does: (body: string) => boolean,
  delegates?: RegExp,
): ReimplEntry => ({
  ecosystem: 'npm',
  api,
  packages,
  modules: packages,
  names,
  does,
  ...(delegates ? { delegates } : {}),
});

export const REIMPLEMENTATION_TABLE: readonly ReimplEntry[] = [
  // ---- npm --------------------------------------------------------------
  npm(
    'debounce',
    [...LODASH, 'underscore', 'lodash.debounce', 'throttle-debounce', 'debounce'],
    ['debounce'],
    any(JS_TIMER),
  ),
  npm(
    'throttle',
    [...LODASH, 'underscore', 'lodash.throttle', 'throttle-debounce'],
    ['throttle'],
    any(JS_TIMER, /\b(Date\.now|performance\.now)\s*\(/),
  ),
  npm(
    'cloneDeep',
    [...LODASH, 'lodash.clonedeep', 'rfdc', 'clone-deep', 'clone', 'klona'],
    ['deepClone', 'cloneDeep', 'deepCopy'],
    any(JS_WALK),
    /\bstructuredClone\s*\(/,
  ),
  npm(
    'isEqual',
    [...LODASH, 'lodash.isequal', 'fast-deep-equal', 'deep-equal', 'dequal'],
    ['deepEqual', 'isDeepEqual', 'deepEquals'],
    any(JS_WALK),
  ),
  npm(
    'merge',
    [...LODASH, 'lodash.merge', 'deepmerge', 'deepmerge-ts', 'merge-deep'],
    ['deepMerge', 'mergeDeep'],
    any(JS_WALK),
  ),
  npm(
    'uuid',
    ['uuid'],
    ['uuid', 'uuidv4', 'generateUuid', 'createUuid', 'newUuid', 'makeUuid'],
    any(/\bMath\.random\s*\(/, /\bgetRandomValues\s*\(/, /\brandomBytes\s*\(/),
    /\brandomUUID\s*\(/,
  ),
  npm(
    'nanoid',
    ['nanoid'],
    ['nanoid'],
    any(/\bMath\.random\s*\(/, /\bgetRandomValues\s*\(/, /\brandomBytes\s*\(/),
  ),
  npm(
    'slugify',
    ['slugify', '@sindresorhus/slugify', 'slug', 'limax', 'url-slug'],
    ['slugify'],
    all(/\.replace(All)?\s*\(/, /\.(toLowerCase|normalize)\s*\(/),
  ),
  npm(
    'retry',
    ['p-retry', 'async-retry', 'retry', 'promise-retry', 'exponential-backoff', 'cockatiel'],
    ['retry', 'withRetry', 'retryAsync', 'retryWithBackoff'],
    all(/\b(for|while)\b/, /\bcatch\b/),
  ),
  npm(
    'classnames',
    ['classnames', 'clsx'],
    // Not `cx`: two letters collide with every minifier's output.
    ['classNames', 'clsx'],
    all(/\b(for|while)\b|\.(filter|map|reduce|forEach)\s*\(/, /\.join\s*\(|\+=/),
  ),
  npm(
    'escape',
    [...LODASH, 'lodash.escape', 'escape-html', 'he'],
    ['escapeHtml'],
    any(/\.replace(All)?\s*\(/),
  ),
  npm(
    'camelCase',
    [...LODASH, 'lodash.camelcase', 'camelcase', 'change-case'],
    ['camelCase', 'toCamelCase'],
    any(/\.replace(All)?\s*\(/, /\.split\s*\(/),
  ),
  npm(
    'kebabCase',
    [...LODASH, 'lodash.kebabcase', 'change-case'],
    ['kebabCase', 'toKebabCase'],
    any(/\.replace(All)?\s*\(/, /\.split\s*\(/),
  ),
  npm(
    'snakeCase',
    [...LODASH, 'lodash.snakecase', 'change-case'],
    ['snakeCase', 'toSnakeCase'],
    any(/\.replace(All)?\s*\(/, /\.split\s*\(/),
  ),
  // ---- PyPI -------------------------------------------------------------
  {
    ecosystem: 'pypi',
    api: 'slugify',
    packages: ['python-slugify', 'awesome-slugify', 'django'],
    modules: ['slugify', 'django.utils.text'],
    names: ['slugify'],
    does: any(/\bre\.sub\s*\(/, /\.translate\s*\(/, /\bnormalize\s*\(/),
  },
  {
    ecosystem: 'pypi',
    api: 'retry',
    packages: ['tenacity', 'retrying', 'backoff', 'retry', 'stamina'],
    modules: ['tenacity', 'retrying', 'backoff', 'retry', 'stamina'],
    names: ['retry', 'with_retry', 'retry_with_backoff', 'retry_async'],
    does: all(/\b(for|while)\b/, /\bexcept\b/),
  },
  {
    ecosystem: 'pypi',
    api: 'inflection',
    packages: ['inflection'],
    modules: ['inflection'],
    names: ['camelize', 'pluralize', 'singularize', 'titleize'],
    does: any(/\bre\.sub\s*\(/, /\.endswith\s*\(/, /\.split\s*\(/),
  },
  {
    ecosystem: 'pypi',
    api: 'more_itertools.chunked',
    packages: ['more-itertools', 'toolz'],
    modules: ['more_itertools', 'toolz'],
    names: ['chunked', 'chunks'],
    does: any(/\brange\s*\(/, /\bislice\s*\(/),
  },
  // ---- Go ---------------------------------------------------------------
  {
    ecosystem: 'go',
    api: 'uuid.New',
    packages: ['github.com/google/uuid', 'github.com/gofrs/uuid', 'github.com/satori/go.uuid'],
    modules: ['github.com/google/uuid', 'github.com/gofrs/uuid', 'github.com/satori/go.uuid'],
    names: ['NewUUID', 'GenerateUUID', 'UUIDv4', 'NewUUIDv4', 'RandomUUID'],
    does: any(/\brand\.(Read|Int|Intn)\s*\(/),
  },
  {
    ecosystem: 'go',
    api: 'slug.Make',
    packages: [
      'github.com/gosimple/slug',
      'github.com/mozillazg/go-slugify',
      'github.com/metal3d/go-slugify',
    ],
    modules: [
      'github.com/gosimple/slug',
      'github.com/mozillazg/go-slugify',
      'github.com/metal3d/go-slugify',
    ],
    names: ['Slugify', 'MakeSlug', 'ToSlug'],
    does: any(/\bregexp\./, /\bstrings\.(Map|ToLower|ReplaceAll|Fields)\s*\(/, /\bunicode\./),
  },
  {
    ecosystem: 'go',
    api: 'retry',
    packages: [
      'github.com/avast/retry-go',
      'github.com/cenkalti/backoff',
      'github.com/sethvargo/go-retry',
    ],
    // Every retry/backoff library counts as delegation, not only the one the
    // project declares: a Retry built on jpillora/backoff is a wrapper.
    modules: [
      'github.com/avast/retry-go',
      'github.com/cenkalti/backoff',
      'github.com/sethvargo/go-retry',
      'github.com/jpillora/backoff',
      'github.com/hashicorp/go-retryablehttp',
      'k8s.io/apimachinery/pkg/util/wait',
      'k8s.io/client-go/util/retry',
    ],
    names: ['Retry', 'WithRetry', 'RetryWithBackoff'],
    does: all(/\bfor\b/, /\btime\.(Sleep|After|NewTimer|NewTicker)\s*\(/),
  },
  // ---- Maven ------------------------------------------------------------
  {
    ecosystem: 'maven',
    api: 'StringUtils.isBlank',
    packages: ['org.apache.commons:commons-lang3', 'commons-lang:commons-lang'],
    modules: ['org.apache.commons.lang3', 'org.apache.commons.lang'],
    names: ['isBlank', 'isNotBlank'],
    does: any(/\.trim\s*\(/, /isWhitespace\s*\(/, /\.charAt\s*\(/),
    delegates: /\.(isBlank|strip)\s*\(\s*\)/,
  },
  {
    ecosystem: 'maven',
    api: 'Strings.isNullOrEmpty',
    packages: ['com.google.guava:guava'],
    modules: ['com.google.common'],
    names: ['isNullOrEmpty'],
    does: all(/==\s*null|null\s*==/, /\.(isEmpty|length)\s*\(/),
  },
  {
    ecosystem: 'maven',
    api: 'Slugify',
    packages: ['com.github.slugify:slugify'],
    modules: ['com.github.slugify'],
    names: ['slugify', 'toSlug'],
    does: any(/\bNormalizer\./, /\.replaceAll\s*\(/),
  },
  {
    ecosystem: 'maven',
    api: 'retry',
    packages: [
      'dev.failsafe:failsafe',
      'net.jodah:failsafe',
      'io.github.resilience4j:resilience4j-retry',
      'org.springframework.retry:spring-retry',
    ],
    modules: [
      'dev.failsafe',
      'net.jodah.failsafe',
      'io.github.resilience4j',
      'org.springframework.retry',
    ],
    names: ['retry', 'withRetry', 'executeWithRetry', 'retryWithBackoff'],
    does: all(/\b(for|while)\b/, /\bcatch\b/),
  },
];

const fold = (name: string): string => name.toLowerCase().replace(/_/g, '');

const LANGUAGE: readonly [RegExp, Language, DeclaredEcosystem][] = [
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, 'js', 'npm'],
  [/\.py$/, 'python', 'pypi'],
  [/\.go$/, 'go', 'go'],
  [/\.java$/, 'java', 'maven'],
];

/** Tests, generated output and declaration files say nothing about shipped code. */
const SKIP_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.go$)|((^|\/)test_[^/]*\.py$)|(_test\.py$)|(\.d\.[cm]?ts$)|(\.min\.js$)|((^|\/)(__tests__|src\/test|node_modules|vendor|third_party|generated|__generated__|dist|build)\/)/;

export interface Reimplementation {
  ruleId: typeof LIBRARY_REIMPLEMENTATION_RULE_ID;
  file: string;
  line: number;
  name: string;
  api: string;
  /** The declared package that already provides it. */
  dependency: string;
  /** The declaration line, verbatim. */
  declaration: string;
  message: string;
}

interface FunctionDecl {
  name: string;
  index: number;
  /** Body text from the masked source, strings blanked. */
  body: string;
}

export function libraryReimplementations(
  sources: readonly { path: string; source: string }[],
  dependencies: readonly DeclaredDependency[],
): Reimplementation[] {
  const direct = dependencies.filter((d) => d.scope === 'direct');
  if (direct.length === 0) return [];
  const out: Reimplementation[] = [];

  for (const file of sources) {
    if (SKIP_FILE.test(file.path) || NOT_A_PROJECT.test(file.path)) continue;
    const lang = LANGUAGE.find(([pattern]) => pattern.test(file.path));
    if (!lang) continue;
    const [, language, ecosystem] = lang;

    // The project(s) this file belongs to: every manifest directory above it.
    const declared = new Map<string, string>();
    for (const dep of direct) {
      if (dep.ecosystem !== ecosystem) continue;
      if (dep.unit !== '' && !file.path.startsWith(`${dep.unit}/`)) continue;
      declared.set(normalizePackage(ecosystem, dep.name), dep.name);
    }
    if (declared.size === 0) continue;

    const entries = REIMPLEMENTATION_TABLE.filter(
      (e) =>
        e.ecosystem === ecosystem &&
        e.packages.some((p) => declared.has(normalizePackage(ecosystem, p))),
    );
    if (entries.length === 0) continue;

    const lines = file.source.split('\n');
    // A bundle or minified asset: its helpers are its dependencies' code,
    // inlined, and its names are whatever the minifier chose.
    if (lines.some((line) => line.length > 500)) continue;
    const masked = language === 'python' ? maskPython(file.source) : maskSource(file.source);
    const imported = importedModules(language, file.source, masked);

    for (const fn of functionsOf(language, masked)) {
      const folded = fold(fn.name);
      // Module level only (JS). A helper nested inside another function or an
      // IIFE is local by design — a standalone browser snippet that cannot
      // import lodash, a slug for one page's anchors — not a utility someone
      // re-wrote instead of importing.
      if (language === 'js' && braceDepth(masked, fn.index) > 0) continue;
      for (const entry of entries) {
        if (!entry.names.some((n) => fold(n) === folded)) continue;
        if (
          entry.modules.some((mod) =>
            imported.some((i) => i === mod || i.startsWith(`${mod}/`) || i.startsWith(`${mod}.`)),
          )
        ) {
          continue;
        }
        if (!entry.does(fn.body)) continue;
        if (entry.delegates?.test(fn.body)) continue;
        if (delegatesByName(fn.body, folded, fold(entry.api))) continue;
        const pkg = entry.packages.find((p) => declared.has(normalizePackage(ecosystem, p)))!;
        const dependency = declared.get(normalizePackage(ecosystem, pkg))!;
        const line = lineAt(masked, fn.index);
        out.push({
          ruleId: LIBRARY_REIMPLEMENTATION_RULE_ID,
          file: file.path,
          line,
          name: fn.name,
          api: entry.api,
          dependency,
          declaration: (lines[line - 1] ?? '').trim(),
          message:
            `${fn.name} re-implements ${entry.api}, which ${dependency} — already a direct ` +
            `runtime dependency of this project — provides. A hand-rolled copy usually lacks ` +
            `the edge cases the library handles; import it instead, or say in a comment why not.`,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * A call whose name carries the API's name — `_.debounce(`, `lodashDebounce(`,
 * `debounceImpl(` — means the function hands the work to someone else. A bare
 * call of its own name is recursion (a deep clone recurses), and stays.
 */
function delegatesByName(body: string, own: string, api: string): boolean {
  for (const m of body.matchAll(/(\.?)\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const callee = fold(m[2]!);
    if (callee === own && m[1] !== '.') continue;
    // The API's own name is only a signal when it is distinctive: `New` from
    // `uuid.New` would match every constructor call in Go.
    const apiName = fold(api.split('.').pop()!);
    if (callee.includes(own) || (apiName.length >= 5 && callee.includes(apiName))) return true;
  }
  return false;
}

function importedModules(language: Language, source: string, masked: string): string[] {
  if (language === 'js') return importsOf(source, masked).map((i) => i.specifier);
  if (language === 'python') {
    const out: string[] = [];
    for (const m of masked.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) out.push(m[1]!);
    for (const m of masked.matchAll(/^\s*import\s+([\w.,\s]+?)(?:\s+as\s+\w+)?\s*$/gm)) {
      for (const part of m[1]!.split(',')) out.push(part.trim().split(/\s+/)[0]!);
    }
    return out;
  }
  if (language === 'java') {
    return [...masked.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)].map((m) => m[1]!);
  }
  // Go: import paths are strings, blanked in `masked`; read them from source.
  const out: string[] = [];
  const block = /\bimport\s*\(([\s\S]*?)\)/g;
  for (const m of source.matchAll(block)) {
    for (const s of m[1]!.matchAll(/"([^"]+)"/g)) out.push(s[1]!);
  }
  for (const m of source.matchAll(/\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g)) out.push(m[1]!);
  return out;
}

/**
 * Index of the `(` that opens the parameters, skipping a TypeScript type
 * parameter list — `<T extends (...a: never[]) => void>` holds parentheses
 * and an arrow's `>`, so it is walked rather than matched.
 */
function afterGenerics(masked: string, at: number): number {
  let i = at;
  if (masked[i] === '<') {
    let depth = 0;
    for (; i < masked.length; i++) {
      if (masked[i] === '<') depth++;
      else if (masked[i] === '>' && masked[i - 1] !== '=' && --depth === 0) break;
    }
    i++;
    while (/\s/.test(masked[i] ?? '')) i++;
  }
  return masked[i] === '(' ? i : -1;
}

/** Unclosed `{` before `index` in masked text: 0 at module level. */
function braceDepth(masked: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') depth--;
  }
  return depth;
}

/** Index of the bracket that closes the one at `open`, or -1. */
function closing(text: string, open: number): number {
  const pair: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const want = pair[text[open]!];
  if (!want) return -1;
  const opener = text[open]!;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === want && --depth === 0) return i;
  }
  return -1;
}

/** The `{…}` block that starts at or after `from`, as long as only `skip` precedes it. */
function blockAfter(masked: string, from: number, skip: RegExp): string | null {
  const brace = masked.indexOf('{', from);
  if (brace === -1 || !skip.test(masked.slice(from, brace))) return null;
  const end = closing(masked, brace);
  return end === -1 ? null : masked.slice(brace + 1, end);
}

function functionsOf(language: Language, masked: string): FunctionDecl[] {
  const out: FunctionDecl[] = [];
  if (language === 'python') {
    const lines = masked.split('\n');
    let offset = 0;
    const starts = lines.map((line) => {
      const at = offset;
      offset += line.length + 1;
      return at;
    });
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]!);
      if (!m) continue;
      const indent = m[1]!.length;
      // Module level only, for the reason given at braceDepth's call site.
      if (indent > 0) continue;
      // The signature may span lines; the body starts after the line whose
      // parentheses balance.
      let j = i;
      let depth = 0;
      for (; j < lines.length; j++) {
        depth +=
          (lines[j]!.match(/[([{]/g) ?? []).length - (lines[j]!.match(/[)\]}]/g) ?? []).length;
        if (depth <= 0) break;
      }
      const body: string[] = [];
      for (let k = j + 1; k < lines.length; k++) {
        const line = lines[k]!;
        if (line.trim() === '') continue;
        if (line.length - line.trimStart().length <= indent) break;
        body.push(line);
      }
      out.push({ name: m[2]!, index: starts[i]! + m[1]!.length, body: body.join('\n') });
    }
    return out;
  }

  if (language === 'go') {
    for (const m of masked.matchAll(/^func\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/gm)) {
      const params = (m.index ?? 0) + m[0].length - 1;
      const close = closing(masked, params);
      if (close === -1) continue;
      const body = blockAfter(masked, close + 1, /^[^{}]*$/);
      if (body !== null) out.push({ name: m[1]!, index: m.index ?? 0, body });
    }
    return out;
  }

  if (language === 'java') {
    for (const m of masked.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)) {
      const before = masked.slice(Math.max(0, (m.index ?? 0) - 80), m.index).trimEnd();
      // A declaration is preceded by its return type, not by `new`, `.`, `=`
      // or an operator — which is what a call would be preceded by.
      if (!/[\w>\]]$/.test(before) || /\b(new|return|else|throw)$/.test(before)) continue;
      const params = (m.index ?? 0) + m[0].length - 1;
      const close = closing(masked, params);
      if (close === -1) continue;
      const body = blockAfter(masked, close + 1, /^\s*(throws\s+[\w.,\s]+)?\s*$/);
      if (body !== null) out.push({ name: m[1]!, index: m.index ?? 0, body });
    }
    return out;
  }

  // JavaScript / TypeScript: function declarations and const-bound functions.
  for (const m of masked.matchAll(
    /(?<![.\w$])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*/g,
  )) {
    const params = afterGenerics(masked, (m.index ?? 0) + m[0].length);
    if (params === -1) continue;
    const close = closing(masked, params);
    if (close === -1) continue;
    // A return-type annotation may sit between `)` and `{`; one with its own
    // braces makes this read the type as the body, which then holds no
    // mechanism and stays silent — the failure is a miss, never a finding.
    const body = blockAfter(masked, close + 1, /^[^;]*$/);
    if (body !== null) out.push({ name: m[1]!, index: m.index ?? 0, body });
  }
  for (const m of masked.matchAll(
    /(?<![.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b[^(<]*)?(?=[(<\w])/g,
  )) {
    let start = (m.index ?? 0) + m[0].length;
    if (masked[start] === '<') {
      start = afterGenerics(masked, start);
      if (start === -1) continue;
    }
    let arrowFrom: number;
    if (masked[start] === '(') {
      const close = closing(masked, start);
      if (close === -1) continue;
      arrowFrom = close + 1;
      if (/function\b[^(<]*$/.test(m[0])) {
        const body = blockAfter(masked, arrowFrom, /^[^;]*$/);
        if (body !== null) out.push({ name: m[1]!, index: m.index ?? 0, body });
        continue;
      }
    } else {
      const ident = /^[A-Za-z_$][\w$]*/.exec(masked.slice(start));
      if (!ident) continue;
      arrowFrom = start + ident[0].length;
    }
    const arrow = /^\s*(?::[^=;{]+)?=>\s*/.exec(masked.slice(arrowFrom));
    if (!arrow) continue;
    const bodyStart = arrowFrom + arrow[0].length;
    if (masked[bodyStart] === '{') {
      const end = closing(masked, bodyStart);
      if (end !== -1) {
        out.push({ name: m[1]!, index: m.index ?? 0, body: masked.slice(bodyStart + 1, end) });
      }
      continue;
    }
    // An expression body: up to the end of the statement at depth zero.
    let depth = 0;
    let end = bodyStart;
    for (; end < masked.length; end++) {
      const c = masked[end]!;
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if ((c === ';' || c === '\n') && depth === 0) break;
    }
    out.push({ name: m[1]!, index: m.index ?? 0, body: masked.slice(bodyStart, end) });
  }
  return out;
}

/**
 * Blanks Python comments and string contents, keeping offsets and newlines —
 * so a docstring that says "retry" or holds a `for` is not code.
 */
export function maskPython(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source.startsWith(quote, j)) break;
        if (!triple && source[j] === '\n') break;
        j++;
      }
      blank(i + quote.length, Math.min(j, source.length));
      i = j + quote.length;
    } else {
      i++;
    }
  }
  return out.join('');
}
