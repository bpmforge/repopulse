// A build script runs once, offline: blocking I/O here blocks no one
// (bpm-perf-sync-io-in-async; W21-20 hand-check).
import { readFileSync, writeFileSync } from 'node:fs';

export async function bundle(src, out) {
  writeFileSync(out, readFileSync(src, 'utf8'));
}
