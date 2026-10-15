// Tests may hand-roll whatever they like.
export function throttle(fn: () => void, ms: number) {
  let last = 0;
  return () => {
    if (Date.now() - last > ms) {
      last = Date.now();
      fn();
    }
  };
}
