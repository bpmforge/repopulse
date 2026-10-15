import { CsvExporter, SystemClock, type ClockSource, type Exporter } from './clock.js';

export function schedule(
  clock: ClockSource = new SystemClock(),
  out: Exporter = new CsvExporter(),
) {
  return out.write([String(clock.now())]);
}
