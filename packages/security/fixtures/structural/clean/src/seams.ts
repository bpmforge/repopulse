// Near-misses for slop.single_impl_interface.

// Two implementations.
export interface Transport {
  send(body: string): void;
}
export class HttpTransport implements Transport {
  send(body: string): void {
    console.info(body);
  }
}
export class QueueTransport implements Transport {
  send(body: string): void {
    console.info(body);
  }
}

// One class, and a test double in tests/ — the double is the second.
export interface Clock {
  now(): number;
}
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

// One class, and an object literal typed as it.
export interface Logger {
  log(line: string): void;
}
export class ConsoleLogger implements Logger {
  log(line: string): void {
    console.info(line);
  }
}
export const silent: Logger = { log() {} };

// One class, and a `satisfies`.
export interface Hasher {
  hash(s: string): string;
}
export class Sha implements Hasher {
  hash(s: string): string {
    return s;
  }
}
export const identity = { hash: (s: string) => s } satisfies Hasher;

// One class, and a factory returning a literal.
export interface Cache {
  get(k: string): string | undefined;
}
export class MapCache implements Cache {
  get(k: string): string | undefined {
    return k;
  }
}
export function nullCache(): Cache {
  return { get: () => undefined };
}

// Re-exported by index.ts: published, its other implementations are consumers'.
export interface PublicSink {
  write(s: string): void;
}
export class FileSink implements PublicSink {
  write(s: string): void {
    console.info(s);
  }
}

// Extended by another interface: a building block.
export interface Named {
  name: string;
}
export interface Person extends Named {
  age: number;
}
export class Employee implements Named {
  name = 'e';
}

// A data shape the class copies from its constructor argument.
export interface SchemaEnvArgs {
  schema: string;
}
export class SchemaEnv implements SchemaEnvArgs {
  schema: string;
  constructor(args: SchemaEnvArgs) {
    this.schema = args.schema;
  }
}

// The one implementation is itself a base: a hierarchy.
export abstract class Figure {
  abstract area(): number;
}
export class Polygon extends Figure {
  area(): number {
    return 0;
  }
}
export class Square extends Polygon {}

// Declaration merging: two declarations of one name.
export interface Merged {
  a: string;
}
export interface Merged {
  b: string;
}
export class MergedImpl implements Merged {
  a = '';
  b = '';
}

// Augmentation of a global: not this repository's interface to count.
declare global {
  interface Window {
    appVersion: string;
  }
}
export class FakeWindow implements Window {}
