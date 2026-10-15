// Near-misses for slop.delegation_wrapper: each of these adds something.
import { fetchUser, formatDate, join, Store } from './api.js';

// async / return await: the result becomes a promise, the frame owns the rejection.
async function loadUser(id: string) {
  return fetchUser(id);
}
function awaitUser(id: string) {
  return (async () => await fetchUser(id))();
}

// Defaults, destructuring, reordering, an extra literal, a dropped parameter.
function withDefault(id = 'me') {
  return fetchUser(id);
}
function fromObject({ id }: { id: string }) {
  return fetchUser(id);
}
function swapped(a: string, b: string) {
  return join(b, a);
}
function withLiteral(id: string) {
  return join(id, 'x');
}
function dropped(id: string, _unused: number) {
  return fetchUser(id);
}

// A thunk: laziness is the point.
const later = () => fetchUser('me');

// Arity truncation: used as a value, so the wrapper stops `map` passing the index.
const toInt = (s: string) => parseInt(s);
const ints = ['1', '2'].map(toInt);

// The receiver changes: `.call` binds `this`.
function isOwn(obj: object, key: string) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Explicit type arguments narrow the call.
function typed(id: string) {
  return fetchUser<string>(id);
}

// The expression goes on after the call.
const chained = (id: string) => fetchUser(id).then((u) => u);

// A combinator: the callee is a parameter.
function apply(fn: (x: string) => string, x: string) {
  return fn(x);
}

// Encapsulation over module state nobody else can reach.
const registry = new Map<string, string>();
export function lookup(key: string) {
  return registry.get(key);
}

// Overloads: the implementation signature is the contract's.
function pick(id: string): string;
function pick(id: number): number;
function pick(id: string | number) {
  return join(id);
}

/** @deprecated use fetchUser — kept so existing callers do not break. */
export function getUser(id: string) {
  return fetchUser(id);
}

// Framework names are looked up by string.
export function handler(event: unknown) {
  return fetchUser(event);
}

// Members forwarding to `this` are composition.
class Facade {
  constructor(private readonly store: Store) {}
  get(key: string) {
    return this.store.get(key);
  }
}

// A class that implements a contract: its methods honour the interface.
class DateFormatter implements Formatter {
  format(date: Date) {
    return formatDate(date);
  }
}

// A class something extends: its methods are override hooks.
class BaseClient {
  makeError(status: number) {
    return formatDate(status);
  }
}
class Client extends BaseClient {}

// Re-exported elsewhere (see index.ts): a public alias, not ours to remove.
export function renderDate(date: Date) {
  return formatDate(date);
}

// Each near-miss is CALLED, so none is skipped for being used as a value —
// only toInt is, on purpose.
void [
  loadUser('a'),
  awaitUser('a'),
  withDefault(),
  fromObject({ id: 'a' }),
  swapped('a', 'b'),
  withLiteral('a'),
  dropped('a', 1),
  later(),
  ints,
  isOwn({}, 'a'),
  typed('a'),
  chained('a'),
  apply((x) => x, 'a'),
  pick('a'),
  new Facade(new Map()).get('a'),
  new DateFormatter().format(new Date()),
  new Client().makeError(1),
];
