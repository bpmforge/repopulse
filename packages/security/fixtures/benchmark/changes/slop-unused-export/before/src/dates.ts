export function parseIsoDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${value}`);
  return d;
}
