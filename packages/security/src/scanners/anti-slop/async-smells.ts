import { CODE, IDENT, lineAt, maskSource } from './source-graph.js';
import {
  closing,
  isGenerated,
  NON_PRODUCT_PATH,
  splitTopLevel,
  skipSpace,
  statementEnd,
  withoutNested,
} from './code-shape.js';

// Async smells (W18-08, mechanical-checks plan §E: R-04 serial awaits, R-11
// unspecified retry).
//
// Both rules read the shape of code a model writes by default and a reviewer
// skims past: one `await` per line, top to bottom, because that is how the
// example read; and `while (true) { try { return await call() } catch {} }`,
// because the happy path is all the prompt described.
//
// PRECISION OVER RECALL. Neither rule can see what a call does, so each fires
// only on the narrow shape where the text itself is the evidence, and stays
// quiet whenever an ordering or a bound could be hiding behind a name.

export const SERIAL_AWAITS_RULE_ID = 'perf.serial_independent_awaits';
export const UNBOUNDED_RETRY_RULE_ID = 'slop.unbounded_retry';

export interface AsyncSmell {
  ruleId: typeof SERIAL_AWAITS_RULE_ID | typeof UNBOUNDED_RETRY_RULE_ID;
  file: string;
  line: number;
  lineEnd: number;
  /** The lines that make the case, verbatim — the evidence quote. */
  evidence: string;
  message: string;
}

// ---------------------------------------------------------------------------
// perf.serial_independent_awaits

/**
 * Callee names that READ. Only these are candidates for running together.
 *
 * Two awaited writes in a row have no data dependency in the text and very
 * often have one in the world — the row has to exist before the audit entry
 * that names it, the directory before the file. A read-only pair is the case
 * where reordering cannot change the outcome, so it is the only case the rule
 * claims.
 */
const READ_CALLEE =
  /^(?:get|fetch|find|load|list|count|select|query|lookup|search|retrieve|describe|stat|lstat|exists|readdir|readlink|read[A-Z_]|resolve[A-Z])/;

/**
 * Read-named calls that are not reads: get-or-create, find-and-update, and the
 * iterator family (`getNext`, `fetchNext`), whose second call depends on the
 * first one having happened.
 */
const NOT_A_READ = /(?:Or|And)[A-Z]|Next|Lock|Claim|Consume|Acquire|Pop|Dequeue|Increment/;

/**
 * Names for ONE connection, wherever they appear in the call — receiver or
 * argument. Queries on a transaction, a single client or a TypeORM query
 * runner are queued by the driver anyway; batching them saves nothing and on
 * some drivers is an error.
 */
const SINGLE_CONNECTION = new Set([
  'tx',
  'trx',
  'txn',
  'transaction',
  'conn',
  'connection',
  'client',
  'session',
  'manager',
  'queryRunner',
  'page',
  'browser',
]);

/**
 * Arguments with a read position: two reads from the same stream, cursor or
 * parser take consecutive pieces of it, so their order IS their meaning.
 */
const STATEFUL_ARG =
  /^(?:stream|reader|cursor|iter(?:ator)?|socket|parser|input|buf(?:fer)?|scanner|lexer|tokenizer|decoder|[\w$]*(?:Stream|Reader|Cursor|Iterator|Socket|Parser))$/;

/** Classes whose `this` is a single connection (TypeORM's query runners and kin). */
const CONNECTION_CLASS = /(?:QueryRunner|Connection|Transaction|Session)$/;

/** Any call in the chain that writes makes the whole statement a write. */
const WRITE_CALL =
  /^(?:insert|update|delete|remove|save|create|upsert|set|put|post|patch|write|destroy|drop|truncate|increment|decrement|exec|execute|run|send|emit|publish|commit|rollback|lock|mark|claim|enqueue|push|add)/i;

/** SQL or HTTP verbs that make a `query()`/`fetch()` a write. */
const WRITE_TEXT =
  /\b(?:insert|update|delete|upsert|merge|create|drop|alter|truncate|grant|begin|commit|rollback|lock|for\s+update|set\s+local)\b|\bmethod\s*:\s*['"`](?:post|put|patch|delete)\b/i;

const CALLEE = new RegExp(
  `^\\s*(?:new\\s+)?(${IDENT}(?:\\s*\\??\\.\\s*#?${IDENT})*)\\s*(?:<[^()]*>)?\\s*\\(`,
);

interface AwaitDecl {
  start: number;
  end: number;
  /** Names the statement binds. Destructuring keys are included, harmlessly. */
  names: string[];
  /** The initializer text after `await` (masked). */
  expr: string;
  readShaped: boolean;
}

function isReadShaped(expr: string, original: string, inConnectionClass: boolean): boolean {
  const m = CALLEE.exec(expr);
  if (!m) return false;
  const path = (m[1] as string).split(/\s*\??\.\s*/);
  if (path[0] === 'this' && inConnectionClass) return false;
  const last = (path[path.length - 1] as string).replace(/^#/, '');
  if (!READ_CALLEE.test(last) || NOT_A_READ.test(last)) return false;
  // `repo.getRepository(Job).delete(…)` starts with a read-named call.
  for (const call of expr.matchAll(new RegExp(`(${IDENT})\\s*(?:<[^()]*>)?\\s*\\(`, 'g'))) {
    if (WRITE_CALL.test(call[1] as string)) return false;
  }
  for (const id of expr.matchAll(new RegExp(IDENT, 'g'))) {
    if (SINGLE_CONNECTION.has(id[0]) || STATEFUL_ARG.test(id[0])) return false;
  }
  return !WRITE_TEXT.test(original);
}

/** Offset ranges of classes whose `this` is one connection. */
function connectionClasses(masked: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of masked.matchAll(new RegExp(`\\bclass\\s+(${IDENT})[^{]*\\{`, 'g'))) {
    if (!CONNECTION_CLASS.test(m[1] as string)) continue;
    const open = m.index + m[0].length - 1;
    out.push([open, closing(masked, open)]);
  }
  return out;
}

function awaitDecls(source: string, masked: string): AwaitDecl[] {
  const out: AwaitDecl[] = [];
  const classes = connectionClasses(masked);
  // One binding: a name, or a flat destructuring pattern, with an optional
  // type. Kept narrow so a match cannot start at a `for (const x of …)` head
  // and run on into the loop body.
  const decl = new RegExp(
    `\\b(?:const|let|var)\\s+(${IDENT}|\\{[^{}=;()]*\\}|\\[[^[\\]=;()]*\\])(?:\\s*:[^=;(){}]+)?\\s*=\\s*await\\b`,
    'g',
  );
  for (const m of masked.matchAll(decl)) {
    const start = m.index;
    const exprStart = start + m[0].length;
    const end = statementEnd(masked, exprStart);
    const expr = masked.slice(exprStart, end);
    const names = [...(m[1] as string).matchAll(new RegExp(IDENT, 'g'))].map((n) => n[0]);
    out.push({
      start,
      end,
      names,
      expr,
      readShaped: isReadShaped(
        expr,
        source.slice(exprStart, end),
        classes.some(([from, to]) => start > from && start < to),
      ),
    });
  }
  return out;
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);
}

export function serialIndependentAwaits(file: string, source: string): AsyncSmell[] {
  const masked = maskSource(source);
  const lines = source.split('\n');
  const decls = awaitDecls(source, masked);
  const found: AsyncSmell[] = [];

  const emit = (group: AwaitDecl[]): void => {
    if (group.length < 2) return;
    const first = group[0] as AwaitDecl;
    const last = group[group.length - 1] as AwaitDecl;
    const line = lineAt(masked, first.start);
    const lineEnd = lineAt(masked, last.start);
    const evidence = group.map((d) => (lines[lineAt(masked, d.start) - 1] ?? '').trim()).join('\n');
    found.push({
      ruleId: SERIAL_AWAITS_RULE_ID,
      file,
      line,
      lineEnd,
      evidence,
      message:
        `${group.length} awaited reads in a row, and none uses another's result — ` +
        'each waits for the one before it for no reason. Start them together ' +
        '(Promise.all) unless an ordering the code does not show requires them in sequence.',
    });
  };

  let group: AwaitDecl[] = [];
  let prev: AwaitDecl | null = null;
  for (const d of decls) {
    // Adjacent means nothing but whitespace between the two statements: same
    // block, no statement in between that could be the hidden dependency.
    const adjacent = prev !== null && skipSpace(masked, prev.end) === d.start;
    if (!adjacent) {
      emit(group);
      group = [];
    }
    if (!d.readShaped) {
      emit(group);
      group = [];
    } else if (group.some((g) => g.names.some((n) => mentions(d.expr, n)))) {
      emit(group);
      group = [d];
    } else {
      group.push(d);
    }
    prev = d;
  }
  emit(group);
  return found;
}

// ---------------------------------------------------------------------------
// slop.unbounded_retry
//
// WHAT COUNTS AS BOUNDED is shared with the await-in-loop and try/catch-in-loop
// rules' retry carve-out: an attempt counter compared with a limit, a limit
// constant, a deadline or an abort signal, OR a sleep/backoff between tries.
// Any one of them and this rule is silent — it exists for the loop that has
// none, which under an outage turns every caller into a tight loop against the
// thing that is already down.
//
// Retry LIBRARIES are not checked: p-retry, async-retry, axios-retry and the
// `retry` package all default to a finite count with exponential backoff, and
// even `forever: true` keeps the backoff, which is the bound that matters.

/** A sleep or backoff between attempts, by the name of what is called. */
const BACKOFF_CALL =
  /\b[\w$]*(?:sleep|delay|wait|backoff|back_off|settimeout|timeout|pause|jitter|throttle|retryafter)[\w$]*\s*\(/i;

/** Names an attempt counter or a limit goes by. */
const COUNTER_OR_LIMIT =
  /attempt|retr(?:y|ies)|tries|tried|count|fail|errors|iteration|budget|max|limit|^n$|^i$/i;

/** Anything that ends the loop on time or cancellation instead of a count. */
const TIME_OR_CANCEL =
  /\b(?:Date\.now|performance\.now|deadline|signal|cancel(?:led|ed)?|stopped|shuttingDown|closed)\b|[Aa]bort/;

const COMPARISON = /([\w$.[\]]+)\s*(?:<=?|>=?|[!=]==?)\s*([\w$.[\]]+)/g;

function hasBound(text: string): boolean {
  if (BACKOFF_CALL.test(text) || TIME_OR_CANCEL.test(text)) return true;
  for (const m of text.matchAll(COMPARISON)) {
    const sides = [m[1] as string, m[2] as string].map((s) => s.split('.').pop() ?? s);
    if (sides.some((s) => COUNTER_OR_LIMIT.test(s))) return true;
  }
  return false;
}

/**
 * An exit in the catch — rethrow, return, break, or a helper that throws
 * (`this.rethrowGrpcError(err)`) — or an await, which is a pause before the
 * next try (`await this.recoverFromError(err)`) whatever it is called.
 */
const EXITS =
  /\b(?:throw|return|break|await|process\.exit)\b|\b[\w$]*(?:[Rr]ethrow|[Tt]hrow[A-Z])[\w$]*\s*\(/;

interface TryCatch {
  /** Offset just past the catch block's closing brace. */
  end: number;
  /** Try body with nested function bodies blanked. */
  tryBody: string;
  /** The same with inner loop and switch bodies blanked too, for `break`. */
  tryOwnBreaks: string;
  catchBody: string;
}

/** Try/catch statements in `from..to` that are not inside a nested function. */
function tryCatches(masked: string, from: number, to: number): TryCatch[] {
  const out: TryCatch[] = [];
  const view = withoutNested(masked, from, to, ['function']);
  for (const m of view.matchAll(/\btry\s*\{/g)) {
    const tryOpen = from + m.index + m[0].length - 1;
    const tryClose = closing(masked, tryOpen);
    if (tryClose < 0 || tryClose > to) continue;
    const rest = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(masked.slice(tryClose + 1));
    if (!rest) continue;
    const catchOpen = tryClose + rest[0].length;
    const catchClose = closing(masked, catchOpen);
    if (catchClose < 0 || catchClose > to) continue;
    out.push({
      end: catchClose + 1,
      tryBody: withoutNested(masked, tryOpen + 1, tryClose, ['function']),
      tryOwnBreaks: withoutNested(masked, tryOpen + 1, tryClose, ['function', 'loop']),
      catchBody: withoutNested(masked, catchOpen + 1, catchClose, ['function']),
    });
  }
  return out;
}

const LOOP_HEAD =
  /\b(?:while\s*\(\s*(true|1|!\s*([\w$.]+))\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{|\bdo\s*\{/g;

function retryLoops(file: string, source: string, masked: string): AsyncSmell[] {
  const lines = source.split('\n');
  const found: AsyncSmell[] = [];
  for (const m of masked.matchAll(LOOP_HEAD)) {
    const open = m.index + m[0].length - 1;
    const close = closing(masked, open);
    if (close < 0) continue;
    let flag = m[2] ?? null;
    let loopText = masked.slice(m.index, close + 1);
    if (m[0].startsWith('do')) {
      // do { } while (cond) — only the infinite or flag-driven tails retry
      // without a bound in the header.
      const tail = /^\s*while\s*\(\s*(true|1|!\s*([\w$.]+))\s*\)/.exec(masked.slice(close + 1));
      if (!tail) continue;
      flag = tail[2] ?? null;
      loopText += tail[0];
    }
    if (hasBound(loopText)) continue;

    const retried = tryCatches(masked, open + 1, close).find(
      ({ end, tryBody, tryOwnBreaks, catchBody }) => {
        if (!/\bawait\b/.test(tryBody)) return false;
        // Whatever follows the try/catch in the loop runs on the failure path
        // too. If it can leave the loop or wait, the catch is not the whole story
        // (a stream loop that records the error and stops; a poll that sleeps).
        const after = withoutNested(masked, end, close, ['function', 'loop']);
        if (/\b(?:return|break|throw|await)\b/.test(after)) return false;
        const succeeds =
          /\breturn\b/.test(tryBody) ||
          /\bbreak\b/.test(tryOwnBreaks) ||
          (flag !== null && new RegExp(`${flag.replace(/[.$]/g, '\\$&')}\\s*=[^=]`).test(tryBody));
        return succeeds && !EXITS.test(catchBody);
      },
    );
    if (!retried) continue;
    const line = lineAt(masked, m.index);
    found.push({
      ruleId: UNBOUNDED_RETRY_RULE_ID,
      file,
      line,
      lineEnd: lineAt(masked, close),
      evidence: (lines[line - 1] ?? '').trim(),
      message:
        'This loop retries a failed await with no attempt limit, no deadline and no ' +
        'delay between tries. While the dependency is down it spins as fast as the ' +
        'failure returns. Cap the attempts and back off between them.',
    });
  }
  return found;
}

/** `function name(` · `name = async (` · `async name(` method heads, with their name. */
const FUNCTION_HEAD = new RegExp(
  `\\bfunction\\s*\\*?\\s*(${IDENT})\\s*(?:<[^>(]*>)?\\s*\\(` +
    `|\\b(${IDENT})\\s*=\\s*async\\s*(?:function\\b\\s*\\*?\\s*(?:${IDENT})?\\s*)?\\(` +
    `|(?:^|[\\s;{}])async\\s+(${IDENT})\\s*(?:<[^>(]*>)?\\s*\\(`,
  'g',
);

/**
 * Recursion as retry: the catch calls the function again, with nothing that
 * changes between calls but the hope that the error went away.
 */
function retryRecursion(file: string, source: string, masked: string): AsyncSmell[] {
  const lines = source.split('\n');
  const found: AsyncSmell[] = [];
  for (const m of masked.matchAll(FUNCTION_HEAD)) {
    const name = (m[1] ?? m[2] ?? m[3]) as string;
    if (name === 'if' || name === 'while' || name === 'for' || name === 'switch') continue;
    const paramsOpen = m.index + m[0].length - 1;
    const paramsClose = closing(masked, paramsOpen);
    if (paramsClose < 0) continue;
    const bodyOpen = masked.indexOf('{', paramsClose);
    // The body brace must follow the parameter list (an arrow, a return type).
    if (bodyOpen < 0 || /[;]/.test(masked.slice(paramsClose, bodyOpen))) continue;
    const bodyClose = closing(masked, bodyOpen);
    if (bodyClose < 0) continue;
    if (hasBound(masked.slice(paramsOpen, bodyClose + 1))) continue;

    // A retry calls itself with what it was given. A call with other arguments
    // — `this.trigger('error', e)` from inside `trigger` — is the function
    // reporting its failure through itself, not trying again.
    const given = splitTopLevel(masked.slice(paramsOpen + 1, paramsClose), true).map((p) =>
      (p.split('=')[0] ?? '').replace(/[?:].*$/s, '').trim(),
    );
    const self = new RegExp(
      `(?<![\\w$]|[^.]\\.)(?:this\\.)?${name.replace(/\$/g, '\\$')}\\s*\\(`,
      'g',
    );
    const retried = tryCatches(masked, bodyOpen + 1, bodyClose).find(({ tryBody, catchBody }) => {
      if (!/\bawait\b/.test(tryBody) || /\bthrow\b/.test(catchBody)) return false;
      // An await before the call again is a pause, whatever it is named.
      const awaits = catchBody.match(/\bawait\b/g)?.length ?? 0;
      const awaitsSelf =
        catchBody.match(new RegExp(`\\bawait\\s+${self.source}`, 'g'))?.length ?? 0;
      if (awaits > awaitsSelf) return false;
      for (const call of catchBody.matchAll(self)) {
        const open = call.index + call[0].length - 1;
        const close = closing(catchBody, open);
        if (close < 0) continue;
        const args = splitTopLevel(catchBody.slice(open + 1, close));
        if (args.length === given.length && args.every((a, i) => a === given[i])) return true;
      }
      return false;
    });
    if (!retried) continue;
    const line = lineAt(masked, m.index);
    found.push({
      ruleId: UNBOUNDED_RETRY_RULE_ID,
      file,
      line,
      lineEnd: lineAt(masked, bodyClose),
      evidence: (lines[line - 1] ?? '').trim(),
      message:
        `${name} calls itself again from its own catch with no attempt count, deadline ` +
        'or delay. A persistent failure recurses until the stack or the dependency gives ' +
        'out. Pass an attempt number, stop at a limit, and back off between tries.',
    });
  }
  return found;
}

export function unboundedRetries(file: string, source: string): AsyncSmell[] {
  const masked = maskSource(source);
  return [...retryLoops(file, source, masked), ...retryRecursion(file, source, masked)];
}

/** Both rules over a snapshot's product code. */
export function asyncSmells(files: readonly { path: string; source: string }[]): AsyncSmell[] {
  const out: AsyncSmell[] = [];
  for (const f of files) {
    if (!CODE.test(f.path) || NON_PRODUCT_PATH.test(f.path) || isGenerated(f.source)) continue;
    out.push(...serialIndependentAwaits(f.path, f.source), ...unboundedRetries(f.path, f.source));
  }
  return out;
}
