/**
 * Generates a prefixed identifier.
 *
 * This function takes a prefix and a number and combines them into a
 * single identifier string. The number is converted to base 36 to keep
 * the identifier short. The prefix and the number are separated by an
 * underscore character.
 *
 * @param prefix - The prefix to use for the identifier.
 * @param n - The number to encode in the identifier.
 * @returns The generated identifier string.
 * @example
 * prefixedId('usr', 42); // 'usr_16'
 */
export function prefixedId(prefix: string, n: number): string {
  return `${prefix}_${n.toString(36)}`;
}
