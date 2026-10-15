// slop.speculative_param and slop.orphan_flag — CLEAN near-misses (W18-08).
// Expected findings: 0.

// A caller passes the defaulted parameter.
function page(items, size = 20) {
  return items.slice(0, size);
}

// Passed as a callback: Array#map passes an index into `depth`.
function indent(line, depth = 0) {
  return '  '.repeat(depth) + line;
}

// Exported: callers outside this repository can pass it.
export function paginate(items, size = 50) {
  return items.slice(0, size);
}

// A default computed from another parameter is a local variable, not a knob.
function handle(xs, x = xs[0]) {
  return x;
}

// Reassigned in the body: an accumulator declared in the parameter list.
const collect = (req, body = []) =>
  new Promise((resolve) => req.on('data', (c) => body.push(c)).on('end', () => resolve(body)));

// Spread call: the argument count cannot be read.
function sum(a, b = 0) {
  return a + b;
}

// Named in a string: may be looked up by name.
function handlerFor(kind, strict = false) {
  return strict ? kind : String(kind);
}

// `arguments` reads what was passed without naming it.
function variadic(first, second = 1) {
  return arguments.length + first + second;
}

export function useAll(list, req, args) {
  page(list, 10);
  list.map(indent);
  handle(list);
  collect(req);
  sum(...args);
  registry['handlerFor'] = true;
  handlerFor('x');
  variadic(1);
}

// orphan_flag near-misses.
const ENABLE_AUDIT = true; // read in two places: a real switch
const USE_CACHE = process.env.USE_CACHE === 'true'; // configuration, not a literal
let SHOW_BANNER = false; // reassignable
const SESSION_PROPAGATION_DEFAULT_ENABLED = true; // a default beside an env var
const MAX_RETRIES = 3; // not flag-shaped

export function audit(event) {
  if (ENABLE_AUDIT) log(event);
  if (ENABLE_AUDIT && event.important) alert(event);
  SHOW_BANNER = USE_CACHE;
  return (process.env.PROPAGATE ?? SESSION_PROPAGATION_DEFAULT_ENABLED) ? MAX_RETRIES : SHOW_BANNER;
}
