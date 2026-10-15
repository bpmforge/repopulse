// slop.stale_jsdoc_param — each block names a parameter its function does not have.

/**
 * Loads one user.
 * @param userId - the user's id
 */
export function loadOne(id: string): string {
  return id;
}

/**
 * Renamed both: the tag set no longer matches the parameter set.
 * @param {string} source the input
 * @param {number} [limit=10] how many
 */
export function take(input: string, max = 10): string {
  return input.slice(0, max);
}

/**
 * Nested names under a head that no longer exists.
 * @param {object} opts
 * @param {boolean} opts.verbose
 */
export const render = (options: { verbose: boolean }): string => String(options.verbose);

export class Cache {
  /**
   * A parameter that was removed.
   * @param key the cache key
   */
  clear(): void {}
}
