// lodash is dev-only: shipped code cannot import it.
export function debounce(fn: () => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}
