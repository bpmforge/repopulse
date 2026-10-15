import { CODE, IDENT, lineAt, looksMinified, maskSource } from './source-graph.js';
import { classesOf, functionAt, skipWs } from './signatures.js';

// Stale JSDoc parameters (W18-05, CODE_HEALTH_SUITE.md §1 R-15).
//
// `@param userId` above `function load(id)`: the documentation describes a
// function that no longer exists, usually because a parameter was renamed and
// the comment was generated once and never read again. A wrong doc is worse
// than none — it is believed.
//
// The rule fires on one thing only: a TAG NAMING A PARAMETER THE FUNCTION DOES
// NOT HAVE. A parameter with no tag is an incomplete doc, not a wrong one, and
// is left alone. What JSDoc legitimately allows is read as allowed:
//
//   - `@param {T} [name=default]`, `@param {...T} name`, `@param name - text`;
//   - `options.field` / `opts[].field` nesting — only the head is a parameter;
//   - destructured parameters, which have no name of their own: a tag may name
//     the object (`@param options`) or the fields inside the pattern, and one
//     unmatched head per destructured parameter is absorbed;
//   - a body that reads `arguments`, which takes parameters it never declares.
//
// A block that documents something other than the function after it —
// `@callback`, `@typedef`, `@function`, `@overload`, … — or a function this
// cannot read with certainty is skipped. JS/TS only.

export const STALE_JSDOC_RULE_ID = 'slop.stale_jsdoc_param';

export interface StaleJsdoc {
  ruleId: typeof STALE_JSDOC_RULE_ID;
  file: string;
  /** The function's name, or '' for an anonymous one. */
  name: string;
  /** Line of the first stale tag. */
  line: number;
  stale: string[];
  params: string[];
  /** The first stale tag's line, verbatim — the evidence quote. */
  tag: string;
  message: string;
}

const FIXTURE = /(^|\/)(__fixtures__|fixtures?)\//;

/** Tags that make the block about something other than the next function. */
const ELSEWHERE =
  /@(callback|typedef|function|func|method|name|overload|lends|borrows|memberof|property|prop|type|interface|event|external|module|namespace)\b/;

interface Tag {
  name: string;
  offset: number;
}

/** The head names of a block's `@param` tags, or null if one is unreadable. */
function paramTags(raw: string): Tag[] | null {
  // The leading `*` of each line is layout; blank it so a tag may wrap.
  const comment = raw.replace(/\n[ \t]*\*(?!\/)/g, (s) => s.replace(/\*/, ' '));
  const tags: Tag[] = [];
  for (const m of comment.matchAll(/@(?:param|arg|argument)\b/g)) {
    let i = skipWs(comment, (m.index ?? 0) + m[0].length);
    if (comment[i] === '{') {
      let depth = 0;
      for (; i < comment.length; i++) {
        if (comment[i] === '{') depth++;
        else if (comment[i] === '}' && --depth === 0) break;
      }
      i = skipWs(comment, i + 1);
    }
    const name = new RegExp(`^\\[?\\s*(?:\\.\\.\\.)?(${IDENT})`).exec(comment.slice(i, i + 200));
    if (!name) return null;
    tags.push({ name: name[1] as string, offset: m.index ?? 0 });
  }
  return tags;
}

/** `/**` blocks that are comments, not text inside a string or a line comment. */
function docBlocks(source: string): { start: number; end: number }[] {
  const keep = maskSource(source, true);
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('/**', from);
    if (start === -1) break;
    const end = source.indexOf('*/', start + 3);
    if (end === -1) break;
    from = end + 2;
    // Inside a string the masked text still has it; a comment is blanked.
    if (keep[start] !== ' ') continue;
    // Inside a line comment: a `//` earlier on the line that is itself a comment.
    const lineStart = source.lastIndexOf('\n', start) + 1;
    const slashes = source.slice(lineStart, start).indexOf('//');
    if (slashes !== -1 && keep[lineStart + slashes] === ' ') continue;
    // `/***…` is a banner, not a doc comment.
    if (source[start + 3] === '*') continue;
    out.push({ start, end: end + 2 });
  }
  return out;
}

/** Skips decorators (`@Get(':id')`) between a doc block and its function. */
function skipDecorators(text: string, i: number): number {
  i = skipWs(text, i);
  while (text[i] === '@') {
    const m = new RegExp(`^@${IDENT}(?:\\.${IDENT})*`).exec(text.slice(i, i + 200));
    if (!m) return i;
    i += m[0].length;
    if (text[i] === '(') {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) break;
      }
      i++;
    }
    i = skipWs(text, i);
  }
  return i;
}

/** JSDoc `@param` tags naming parameters their function does not have. */
export function staleJsdocParams(files: readonly { path: string; source: string }[]): StaleJsdoc[] {
  const out: StaleJsdoc[] = [];
  for (const file of files) {
    if (!CODE.test(file.path) || /\.d\.[cm]?ts$/.test(file.path)) continue;
    // Fixtures are deliberately wrong code; tests are kept — a stale doc on a
    // test helper misleads the next person who reads it all the same.
    if (FIXTURE.test(file.path) || looksMinified(file.path, file.source)) continue;
    const masked = maskSource(file.source);
    const lines = file.source.split('\n');
    // Members are read only where one can be: inside a class body.
    const classBodies = classesOf(masked).map((c) => [c.bodyStart, c.bodyEnd] as const);

    const blocks = docBlocks(file.source);
    for (const [k, block] of blocks.entries()) {
      // Stacked doc blocks — one per call shape above a single JS function, or
      // an inline `/** @class */` before the function — are not one function's
      // documentation, and which block describes which shape is not readable.
      const prev = blocks[k - 1];
      const next = blocks[k + 1];
      if (prev && file.source.slice(prev.end, block.start).trim() === '') continue;
      const comment = file.source.slice(block.start, block.end);
      if (ELSEWHERE.test(comment)) continue;
      const tags = paramTags(comment);
      if (!tags || tags.length === 0) continue;

      const at = skipDecorators(masked, block.end);
      if (next && next.start < skipWs(masked, at) + 200 && next.start >= block.end) {
        const between = masked.slice(block.end, next.start);
        if (!/[;{}]/.test(between)) continue;
      }
      const inClass = classBodies.some(([s, e]) => at > s && at < e);
      const site = functionAt(masked, at, inClass);
      if (!site) continue;
      // `export default function` and friends: functionAt reads from `at`.
      if (site.index !== skipWs(masked, at)) continue;

      // A doc above the first overload describes them all, the implementation
      // included: every signature of the name that follows counts.
      const params = [...site.params];
      for (let next = site; next.body.kind === 'none';) {
        const following = functionAt(masked, next.body.end + 1, inClass);
        if (!following || following.name !== site.name) break;
        params.push(...following.params);
        next = following;
      }

      const names = new Set<string>();
      const patternNames = new Set<string>();
      let destructured = 0;
      for (const p of params) {
        if (p.name !== null) names.add(p.name);
        else {
          destructured++;
          for (const n of p.patternNames) patternNames.add(n);
        }
      }
      const heads = [...new Set(tags.map((t) => t.name))];
      // `path3` for `path`, `keys2` for `keys`: a bundler renamed the
      // parameter to dodge a collision and left the doc alone. Not the
      // author's mistake, and not in a file anyone edits.
      const known = (h: string): boolean =>
        names.has(h) ||
        patternNames.has(h) ||
        [...names].some((n) => n.startsWith(h) && /^\d+$/.test(n.slice(h.length)));
      const unmatched = heads.filter((h) => !known(h));
      if (unmatched.length <= destructured) continue;
      // `@param {object} A server address…`, `@param Condition used on…`: the
      // name was left out and the description's first word read in its
      // place. Malformed, not stale — and parameters are not capitalised.
      if (unmatched.some((n) => /^[A-Z]/.test(n)) && ![...names].some((n) => /^[A-Z]/.test(n))) {
        continue;
      }
      if (
        site.body.kind === 'block' &&
        /\barguments\b/.test(masked.slice(site.body.start, site.body.end))
      ) {
        continue;
      }

      // Every unmatched head is reported, though `destructured` of them may be
      // the pattern's name: the reader cannot tell which, and neither can we.
      const first = tags.find((t) => unmatched.includes(t.name)) as Tag;
      const line = lineAt(file.source, block.start + first.offset);
      const shown = site.params.map((p) => p.name ?? '{…}');
      out.push({
        ruleId: STALE_JSDOC_RULE_ID,
        file: file.path,
        name: site.name,
        line,
        stale: unmatched,
        params: shown,
        tag: (lines[line - 1] ?? '').trim().replace(/^\*\s*/, ''),
        message:
          `The doc comment on ${site.name || 'this function'} documents ` +
          `${unmatched.map((n) => `\`${n}\``).join(', ')}, which ${unmatched.length === 1 ? 'is not a parameter' : 'are not parameters'} ` +
          `of it (it takes ${shown.length ? shown.join(', ') : 'none'}). A renamed or removed ` +
          'parameter left its documentation behind; the doc now describes a function that does not exist.',
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
