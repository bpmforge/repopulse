import { CODE, lineAt, maskSource } from './source-graph.js';
import { braceAt, braceTree, looksMinified, matchParenBack, type Brace } from './js-blocks.js';
import {
  PYTHON,
  PY_TEST_PATH,
  blockEnd,
  isStringOnly,
  logicalLines,
  maskPython,
  type PyLine,
} from './python-source.js';

// Repository over CRUD (W18-09, R-08, mechanical-checks plan §E).
//
// `class UserRepository { findById(id) { return this.prisma.user.findUnique(…) } … }`
// — a class whose every method forwards one call to the ORM it wraps. It adds
// a file, an injection token and a mock to every test, and no behaviour: the
// ORM already WAS the repository. Models write it because "add a repository
// layer" is in every tutorial they learned from.
//
// PRECISION OVER RECALL. A repository earns its keep the moment one method
// does anything — composes two queries, maps rows to domain objects, wraps a
// transaction — so ONE such method clears the whole class. It must also have
// at least MIN_METHODS methods: a two-method class is too small to call a
// layer, and too cheap to be worth a finding. The class has to call itself a
// Repository; other wrappers are the delegation rule's business.

export const REPOSITORY_CRUD_RULE_ID = 'slop.repository_over_crud';

export const MIN_METHODS = 3;

export interface RepositoryOverCrud {
  ruleId: typeof REPOSITORY_CRUD_RULE_ID;
  file: string;
  line: number;
  className: string;
  methods: string[];
  /** The class line, verbatim — the evidence quote. */
  declaration: string;
  message: string;
}

/**
 * Method names ORMs and query builders expose — Prisma, TypeORM, Sequelize,
 * Mongoose, Drizzle, Knex, Kysely, MikroORM; SQLAlchemy, Django, Tortoise,
 * Peewee, PyMongo, SQLModel.
 */
const ORM_CALL = new Set([
  'find',
  'findOne',
  'findMany',
  'findUnique',
  'findFirst',
  'findById',
  'findByPk',
  'findAll',
  'findOneBy',
  'findBy',
  'findAndCount',
  'findOneOrFail',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'findByIdAndUpdate',
  'findByIdAndDelete',
  'findOneAndUpdate',
  'findOneAndDelete',
  'create',
  'createMany',
  'insert',
  'insertOne',
  'insertMany',
  'insertInto',
  'update',
  'updateOne',
  'updateMany',
  'updateTable',
  'delete',
  'deleteOne',
  'deleteMany',
  'deleteFrom',
  'remove',
  'destroy',
  'softDelete',
  'restore',
  'save',
  'upsert',
  'count',
  'exists',
  'aggregate',
  'select',
  'selectFrom',
  'increment',
  'decrement',
  // Python spellings
  'query',
  'filter',
  'filter_by',
  'get',
  'get_or_create',
  'update_or_create',
  'bulk_create',
  'add',
  'add_all',
  'merge',
  'execute',
  'scalars',
  'scalar',
  'scalar_one',
  'scalar_one_or_none',
  'find_one',
  'insert_one',
  'insert_many',
  'update_one',
  'update_many',
  'delete_one',
  'delete_many',
  'get_by_id',
]);

/** Drops the contents of every bracket group: `a.b(x, {y}).c[0]` → `a.b().c[]`. */
function collapse(text: string): string | null {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if ('([{'.includes(ch)) {
      if (depth === 0) out += ch;
      depth++;
    } else if (')]}'.includes(ch)) {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) out += ch;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return depth === 0 ? out : null;
}

/**
 * Words that may appear in a forwarded call without being a decision. Literal
 * constants (`True`, `null`) are NOT here: `filter(User.active == True)` is a
 * named query.
 */
const NEUTRAL = new Set(['return', 'await', 'this', 'self', 'cls', 'as']);
const LITERAL = new Set(['True', 'False', 'None', 'true', 'false', 'null', 'undefined']);

/** SQLAlchemy statement constructors: the call shape of a forwarded query. */
const STATEMENT_CALL = new Set(['select', 'insert', 'update', 'delete', 'where', 'values']);

/**
 * Is `statement` one ORM call that only forwards the method's own parameters?
 *
 * The chain: after collapsing bracket contents, nothing but a member/call
 * chain — no operator, no ternary, no `new`, no second statement — with an ORM
 * method on it.
 *
 * The arguments: parameters, object keys and keyword names, entity classes
 * and their attributes, nothing else. A string or number literal, a call such
 * as `IsNull()` or `func.count()`, or a callback is a DECISION — that method
 * is a named query, which is what a repository is for, and the class is
 * left alone.
 */
function forwardsOneOrmCall(statement: string, params: ReadonlySet<string>): boolean {
  const body = statement
    .trim()
    .replace(/;$/, '')
    .replace(/^return\b\s*/, '')
    .replace(/^await\b\s*/, '')
    .trim();
  const flat = collapse(body);
  if (flat === null) return false;
  const chain = flat.replace(/\s+/g, '').replace(/!/g, '');
  if (!/^(?:[A-Za-z_$][\w$]*|\(\))(?:\??\.[A-Za-z_$][\w$]*|\(\)|\[\])*$/.test(chain)) return false;
  if (!chain.includes('()')) return false;
  const chainCalls = new Set(
    [...chain.matchAll(/([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1] as string),
  );
  // `(await this.session.execute(…)).scalars()` — the leading group's calls are
  // part of the chain too.
  const lead = /^\(\s*(?:await\s+)?([\w$.]+)\s*\(/.exec(body);
  if (lead) for (const part of (lead[1] as string).split('.')) chainCalls.add(part);
  if (![...chainCalls].some((n) => ORM_CALL.has(n))) return false;

  // Callbacks, literals and range comparisons are decisions; `==` against a
  // parameter is a plain lookup.
  if (/=>|\bfunction\b|\blambda\b|["'`]|(?<![\w$.])\d|[<>]|!=/.test(body)) return false;
  const depth: number[] = [];
  let d = 0;
  for (const ch of body) {
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    depth.push(d);
  }
  for (const m of body.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)/g)) {
    const word = m[1] as string;
    const before = body.slice(0, m.index).trimEnd();
    const after = body.slice(m.index + word.length).trimStart();
    if (after.startsWith('(')) {
      // On the chain itself, any call; inside an argument, only the query
      // vocabulary — `.desc()`, `IsNull()` or `func.count()` is a decision.
      const nested = (depth[m.index] ?? 0) > 0;
      if (!nested && chainCalls.has(word)) continue;
      if (nested && (ORM_CALL.has(word) || STATEMENT_CALL.has(word))) continue;
      if (!nested && STATEMENT_CALL.has(word)) continue;
      return false;
    }
    if (before.endsWith('.') || before.endsWith('?.')) continue; // an attribute
    if (/^:(?!:)/.test(after) || /^=(?!=)/.test(after)) continue; // a key or kwarg
    if (LITERAL.has(word)) return false;
    // Capitalised: an entity class, as in `query(User)` or `User.id == id`.
    if (params.has(word) || NEUTRAL.has(word) || /^[A-Z]/.test(word)) continue;
    // `this.repo.find(…)`: the receiver chain's first word.
    if (chain.startsWith(word) || (lead && (lead[1] as string).startsWith(word))) continue;
    return false;
  }
  return true;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k >= 0 && k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) return k;
  }
  return -1;
}

/** Every identifier in a parameter list — names, defaults and types alike. */
function paramNames(list: string): Set<string> {
  return new Set([...list.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
}

// ---- JavaScript / TypeScript ------------------------------------------------

const JS_TEST_PATH = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|__mocks__|tests?|e2e)\//;
const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|testdata|test-data)\//;
const SKIP_MEMBER = new Set(['constructor', 'get', 'set']);

/** One statement in a masked JS body? Semicolons, or lines ASI would split. */
function jsSingleStatement(body: string): string | null {
  const text = body.trim().replace(/;\s*$/, '');
  if (!text) return null;
  const flat = collapse(text);
  if (flat === null || flat.includes(';')) return null;
  const lines = flat
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let k = 1; k < lines.length; k++) {
    const prev = lines[k - 1] as string;
    const cur = lines[k] as string;
    const continues = /^(\??\.|[)\]}])/.test(cur) || /([(,.[{=+\-*/&|?:]|=>)$/.test(prev);
    if (!continues) return null;
  }
  if (/^(const|let|var|if|for|while|switch|try|throw|do|new)\b/.test(text)) return null;
  return text;
}

function jsRepositories(path: string, source: string): RepositoryOverCrud[] {
  const masked = maskSource(source);
  const classes = [...masked.matchAll(/\bclass\s+([A-Za-z_$][\w$]*Repository)\b[^{]*\{/g)];
  if (classes.length === 0) return [];
  const braces = braceTree(masked);
  if (!braces) return [];
  const out: RepositoryOverCrud[] = [];

  for (const m of classes) {
    const body = braceAt(braces, m.index + m[0].length - 1);
    if (body === -1) continue;
    const classBrace = braces[body] as Brace;
    const methods: string[] = [];
    let clean = true;
    let cursor = classBrace.open + 1;
    for (let b = body + 1; b < braces.length && clean; b++) {
      const brace = braces[b] as Brace;
      if (brace.open > classBrace.close) break;
      if (brace.parent !== body) continue;
      // The member's header: everything since the previous member ended.
      const header = masked.slice(cursor, brace.open);
      cursor = brace.close + 1;
      if (brace.kind !== 'function') {
        // An object-literal field initialiser, a static block: not a method,
        // but not forwarding either — leave the class alone.
        if (/=\s*$/.test(header) || /\bstatic\s*$/.test(header)) {
          clean = false;
        }
        continue;
      }
      const name =
        /(?:^|[\s;}])(?:(?:public|private|protected|static|async|override|readonly)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:=\s*(?:async\s*)?)?\(/.exec(
          header.replace(/@[\w$.]+(?:\([^)]*\))?/g, ' '),
        );
      const memberName = name?.[1] ?? '';
      if (SKIP_MEMBER.has(memberName) || /\b(get|set)\s+[\w$#]+\s*\($/.test(header.trim())) {
        continue;
      }
      const statement = jsSingleStatement(masked.slice(brace.open + 1, brace.close));
      const paren = header.lastIndexOf(')');
      const open = paren === -1 ? -1 : matchParenBack(header, paren);
      const params = paramNames(open === -1 ? '' : header.slice(open + 1, paren));
      if (!statement || !forwardsOneOrmCall(statement, params)) {
        clean = false;
        break;
      }
      methods.push(memberName || '(anonymous)');
    }
    // Expression-bodied arrow members (`find = (id) => this.repo.findOne(id)`)
    // have no brace of their own to judge. Rather than half-read them, a class
    // with one is left alone.
    const flatBody = collapse(masked.slice(classBrace.open + 1, classBrace.close));
    if (
      flatBody === null ||
      /=\s*(?:async\s*)?(?:\(\)|[A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=>\s*(?!\{)/.test(flatBody)
    ) {
      clean = false;
    }
    if (!clean || methods.length < MIN_METHODS) continue;
    const line = lineAt(source, m.index);
    out.push(finding(path, line, m[1] as string, methods, source));
  }
  return out;
}

// ---- Python -----------------------------------------------------------------

function pyRepositories(path: string, source: string): RepositoryOverCrud[] {
  const lines = logicalLines(source, maskPython(source));
  const out: RepositoryOverCrud[] = [];
  lines.forEach((l, k) => {
    const cls = /^class\s+(\w*Repository)\b[^:]*:\s*$/.exec(l.text);
    if (!cls) return;
    const end = blockEnd(lines, k);
    if (end === k + 1) return;
    const memberIndent = (lines[k + 1] as PyLine).indent;
    const methods: string[] = [];
    for (let n = k + 1; n < end; n = blockEnd(lines, n)) {
      const member = lines[n] as PyLine;
      // Decorators, the class docstring, class attributes and nested classes
      // say nothing either way.
      const def =
        member.indent === memberIndent ? /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(member.text) : null;
      if (!def) continue;
      const name = def[1] as string;
      if (/^__\w+__$/.test(name)) continue;
      const open = member.text.indexOf('(');
      const close = matchParen(member.text, open);
      if (close === -1) return;
      const inline = /^\s*(?:->[^:]*)?:(.*)$/.exec(member.text.slice(close + 1))?.[1]?.trim() ?? '';
      const body = inline ? [{ ...member, text: inline }] : lines.slice(n + 1, blockEnd(lines, n));
      const params = paramNames(member.text.slice(open + 1, close));
      if (!pyForwards(body, params)) return;
      methods.push(name);
    }
    if (methods.length < MIN_METHODS) return;
    out.push(finding(path, l.line, cls[1] as string, methods, source));
  });
  return out;
}

/** A def body that is one ORM call, after an optional docstring. */
function pyForwards(body: readonly PyLine[], params: ReadonlySet<string>): boolean {
  if (body.length === 0) return false;
  const indent = (body[0] as PyLine).indent;
  // Anything deeper than the first statement is inside a compound statement.
  if (body.some((b) => b.indent !== indent)) return false;
  const statements = body.filter((b, i) => !(i === 0 && isStringOnly(b.text)));
  return statements.length === 1 && forwardsOneOrmCall((statements[0] as PyLine).text, params);
}

// ---- Shared -----------------------------------------------------------------

function finding(
  path: string,
  line: number,
  className: string,
  methods: string[],
  source: string,
): RepositoryOverCrud {
  const shown = methods.slice(0, 6).join(', ') + (methods.length > 6 ? ', …' : '');
  return {
    ruleId: REPOSITORY_CRUD_RULE_ID,
    file: path,
    line,
    className,
    methods,
    declaration: (source.split('\n')[line - 1] ?? '').trim().slice(0, 300),
    message:
      `${className} has ${methods.length} methods (${shown}) and every one is a single ORM ` +
      'call passed straight through. The class adds a layer to inject, mock and keep in step ' +
      'with the schema, and no behaviour: call the ORM where it is used, or give the ' +
      'repository the queries that actually need a name.',
  };
}

/** `*Repository` classes whose every method forwards one ORM call. */
export function repositoriesOverCrud(
  files: readonly { path: string; source: string }[],
): RepositoryOverCrud[] {
  const out: RepositoryOverCrud[] = [];
  for (const file of files) {
    if (FIXTURE_PATH.test(file.path) || !/Repository/.test(file.source)) continue;
    if (CODE.test(file.path) && !/\.d\.[cm]?ts$/.test(file.path)) {
      if (JS_TEST_PATH.test(file.path) || looksMinified(file.source)) continue;
      out.push(...jsRepositories(file.path, file.source));
    } else if (PYTHON.test(file.path)) {
      if (PY_TEST_PATH.test(file.path)) continue;
      out.push(...pyRepositories(file.path, file.source));
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
