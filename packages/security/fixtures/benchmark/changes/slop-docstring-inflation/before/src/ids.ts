// Ids are prefixed so a log line says what kind of thing it names.
export function prefixedId(prefix: string, n: number): string {
  return `${prefix}_${n.toString(36)}`;
}
