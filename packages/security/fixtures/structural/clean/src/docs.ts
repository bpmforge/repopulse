// Near-misses for slop.stale_jsdoc_param.

/**
 * A destructured parameter documented by its object name and fields.
 * @param {object} options
 * @param {boolean} options.verbose
 * @param {string} [options.prefix='>']
 */
export function render({ verbose, prefix = '>' }: { verbose: boolean; prefix?: string }) {
  return verbose ? prefix : '';
}

/**
 * Fields of a destructured parameter documented directly.
 * @param verbose
 * @param prefix
 */
export function renderFlat({ verbose, prefix }: { verbose: boolean; prefix: string }) {
  return verbose ? prefix : '';
}

/**
 * Optional with a default, a rest parameter, nested array fields.
 * @param {number} [limit=10] how many
 * @param {...string} parts the parts
 * @param {Array<{id: string}>} rows
 * @param {string} rows[].id
 */
export function many(limit = 10, rows: { id: string }[] = [], ...parts: string[]) {
  return [limit, rows, parts];
}

/**
 * Incomplete, not stale: one parameter has no tag.
 * @param a the first
 */
export function partial(a: number, b: number) {
  return a + b;
}

/**
 * Documented above the first overload, naming the implementation's parameter.
 * @param paramsOrMutator new params, or a function of the old ones
 */
export function setParams(params: object): void;
export function setParams(mutator: (p: object) => object): void;
export function setParams(paramsOrMutator: object | ((p: object) => object)) {
  console.info(paramsOrMutator);
}

/**
 * A callback type, not the function below.
 * @callback Visitor
 * @param {string} node
 */
export function visit(tree: string) {
  return tree;
}

/**
 * Reads `arguments`, so it takes what it never declares.
 * @param {...number} values
 */
export function sum() {
  // eslint-disable-next-line prefer-rest-params
  return Array.from(arguments).length;
}

/**
 * Malformed — the name was left out and the description's first word read in its place.
 * @param {object} A server address object
 */
export function address(addr: object) {
  return addr;
}

/**
 * A bundler renamed the parameter to dodge a collision.
 * @param keys the keys
 */
export function getMany(keys2: string[]) {
  return keys2;
}

/**
 * Two call shapes, one doc block each.
 * @param {number} times
 * @param {object} node
 */
/**
 * @param {object} node
 */
export function isParenthesized(timesOrNode: unknown, maybeNode?: unknown) {
  return [timesOrNode, maybeNode];
}

const text = '/** @param ghost */ function fake(real) {}';
// /** @param ghost2 */
export function realFn(real: string) {
  return real + text;
}

export class Painter {
  /**
   * A decorated method, documented correctly.
   * @param id the id
   */
  @Bound()
  find(id: string) {
    return id;
  }
}
declare function Bound(): MethodDecorator;
