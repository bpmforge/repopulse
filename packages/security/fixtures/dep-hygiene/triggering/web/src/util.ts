// Hand-rolled helpers in a project that already depends on lodash and uuid.

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export const deepClone = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = Array.isArray(value) ? ([] as never) : {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepClone(inner);
  }
  return out as T;
};

export function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
