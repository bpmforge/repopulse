import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every rule id the product ships in a pack (W22-06).
//
// WHY A PROPOSAL MUST NOT REUSE ONE. Registry rows override a shipped rule's
// status by id (shadow.ts `effectiveStatus`): a `proposed` row whose id matched
// a live pack rule would put that live rule back into shadow. A model naming
// its narrower rule after the rule it narrows - the obvious name - would then
// change an existing rule without anyone deciding to. So the learning passes
// treat every shipped id as taken.
//
// Read from the YAML on disk rather than from a scanner's loader: the loaders
// are per engine, and a proposal can collide with any of them.

const RULEPACKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rulepacks');

const ID_LINE = /^\s*-\s+id:\s*["']?([^"'\s#]+)/;

let cached: ReadonlySet<string> | undefined;

function walk(dir: string, out: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.ya?ml$/.test(entry.name)) {
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        const m = ID_LINE.exec(line);
        if (m?.[1]) out.add(m[1]);
      }
    }
  }
}

/** Rule ids shipped under `packages/security/rulepacks`, read once per process. */
export function shippedRuleIds(root: string = RULEPACKS): ReadonlySet<string> {
  if (root !== RULEPACKS) {
    const out = new Set<string>();
    walk(root, out);
    return out;
  }
  if (!cached) {
    const out = new Set<string>();
    walk(root, out);
    cached = out;
  }
  return cached;
}

/** Where the shipped packs live; tests hash it to prove a pass wrote nothing there. */
export const RULEPACKS_DIR = RULEPACKS;
