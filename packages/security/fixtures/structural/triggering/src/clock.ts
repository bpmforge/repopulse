// slop.single_impl_interface — one interface, one class, no test double, no
// object literal typed as it, not re-exported anywhere.
export interface ClockSource {
  now(): number;
}

export class SystemClock implements ClockSource {
  now(): number {
    return Date.now();
  }
}

// And an abstract base with exactly one subclass.
export abstract class Exporter {
  abstract write(rows: string[]): string;
}

export class CsvExporter extends Exporter {
  write(rows: string[]): string {
    return rows.join('\n');
  }
}
