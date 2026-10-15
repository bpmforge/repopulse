// Near-misses for slop.exception_control_flow (W18-09): every throw here
// leaves its function, or is not this function's.
import { EventEmitter } from 'node:events';

export function validate(order: { items: unknown[] }): void {
  // No try at all: the caller handles it.
  if (order.items.length === 0) throw new Error('empty order');
}

export async function processAll(items: string[]): Promise<void> {
  try {
    // Thrown inside callbacks: caught by whoever runs them, not this try.
    items.forEach((item) => {
      if (!item) throw new Error('blank item');
    });
    await Promise.all(
      items.map(async function (item) {
        if (item === 'x') throw new Error('x is reserved');
      }),
    );
    const handlers = {
      onItem(item: string) {
        if (!item) throw new Error('blank');
      },
    };
    handlers.onItem('a');
    class Local {
      check(): void {
        throw new Error('nested class method');
      }
    }
    new Local().check();
  } catch (err) {
    console.error(err);
  }
}

export function cleanupThenPropagate(path: string): void {
  try {
    if (!path) throw new Error('no path');
    writeSomething(path);
  } catch (err) {
    removeTemp(path);
    // A top-level rethrow: the try is cleanup and the error still leaves.
    throw err;
  }
}

export function withFinallyOnly(lock: { release(): void }): void {
  try {
    throw new Error('propagates: no catch');
  } finally {
    lock.release();
  }
}

export function* generator(): Generator<number> {
  const inner = (function* () {
    yield 1;
  })();
  try {
    // `.throw(…)` is a generator method, not a throw statement.
    inner.throw(new Error('stop'));
    yield 2;
  } catch {
    yield 3;
  }
}

export function stringsAndComments(): string {
  try {
    // throw new Error('commented out');
    const text = 'throw new Error("in a string")';
    return `throw ${text}`;
  } catch {
    return '';
  }
}

export function passAlong(job: () => void): void {
  try {
    job();
  } catch (err) {
    try {
      report(err);
    } catch {
      // `throw err` passes an existing error along; it is not a new branch.
    }
    if (shouldStop(err)) throw err;
  }
}

export function emitterOk(): void {
  const e = new EventEmitter();
  try {
    e.emit('x');
  } catch (err) {
    console.error(err);
  }
  throw new Error('after the try, so it leaves');
}

export const retry = async (attempts: number): Promise<string> => {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('/health');
      // The handler can rethrow, so it is a filter: the error may still leave.
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === attempts - 1) throw err;
    }
  }
  return '';
};

declare function report(err: unknown): void;
declare function shouldStop(err: unknown): boolean;
declare function writeSomething(path: string): void;
declare function removeTemp(path: string): void;
