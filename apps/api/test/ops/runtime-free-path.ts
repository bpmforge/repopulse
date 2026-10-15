import { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The deploy-script tests drive "no container runtime on PATH" by putting an
// empty or stub bin dir in front of the system directories. That only works on
// a machine with no docker or podman installed, and CI runners (GitHub's
// ubuntu-latest, act's catthehacker images) ship docker in /usr/bin, so the
// "neither runtime" cases failed everywhere except a bare laptop. This builds
// one directory of symlinks to every system executable EXCEPT the runtimes,
// so the tests control which runtime exists no matter what the host has.

const SYSTEM_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const RUNTIMES = /^(docker|podman)(-compose)?$/;

let cached: string | undefined;

export function runtimeFreeSystemPath(): string {
  if (cached) return cached;
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'rp-sysbin-')), 'bin');
  mkdirSync(dir);
  for (const sys of SYSTEM_DIRS) {
    let names: string[];
    try {
      names = readdirSync(sys);
    } catch {
      continue;
    }
    for (const name of names) {
      if (RUNTIMES.test(name)) continue;
      try {
        // First directory wins, matching PATH order.
        symlinkSync(path.join(sys, name), path.join(dir, name));
      } catch {
        // already linked from an earlier directory
      }
    }
  }
  cached = dir;
  return dir;
}
