import type { Scanner, ScanTrigger } from './framework/types.js';

// The scanner registry (W8-01, SECURITY_SUITE.md §1, FR-SEC-1).
//
// A static list, on purpose. Dynamic discovery would mean the set of things
// that can read a customer's code is decided at runtime by whatever is on disk
// — for a security subsystem that is the wrong default. Adding a scanner is one
// import and one array entry, reviewed like any other code.

const registry = new Map<string, Scanner>();

export function registerScanner(scanner: Scanner): void {
  const existing = registry.get(scanner.key);
  if (existing && existing !== scanner) {
    // Loud, unlike the widget registry which silently overwrote and cost a
    // panel in W5-07. Two scanners under one key means findings attributed to
    // the wrong tool, which is worse than a startup crash.
    throw new Error(
      `Scanner key "${scanner.key}" is already registered by ${existing.displayName}. ` +
        'Keys are stamped onto every finding, so a duplicate would misattribute results.',
    );
  }
  registry.set(scanner.key, scanner);
}

export function getScanner(key: string): Scanner | undefined {
  return registry.get(key);
}

export function listScanners(): Scanner[] {
  return [...registry.values()];
}

/** Test seam: clears the registry between suites. Never called in production. */
export function resetRegistry(): void {
  registry.clear();
}

/**
 * Scanners this trigger may enqueue — metadata only, no key branching.
 *
 * This is the function that makes FR-SEC-1's claim true: dispatch asks the
 * registry what a scanner declared, so a new scanner participates in triggering
 * without the framework learning its name.
 */
export function scannersForTrigger(trigger: ScanTrigger): Scanner[] {
  return listScanners().filter((s) => s.triggers.includes(trigger));
}

/** Tools a set of scanners needs — used to skip what cannot run here. */
export function requiredTools(scanners: readonly Scanner[]): string[] {
  return [...new Set(scanners.flatMap((s) => s.requiredTools ?? []))].sort();
}
