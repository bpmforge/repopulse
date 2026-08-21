import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CHECKLIST_DIR } from '../../scanners/owasp/checklist.js';

// V5's checklist asset (W8-15).
//
// Loaded the same way every other checklist is: highest version wins, the
// version string is stamped on the analysis_runs row, and the file is renamed
// rather than edited when the questions change — a proposal is only
// reproducible against the prompt that produced it.
//
// THE VERSION-MAX LOGIC IS DUPLICATED FROM scanners/owasp/checklist.ts, which
// that file's own comment warns against, and it is duplicated on purpose. The
// shared loader keys on a closed `ChecklistKey` union and a private FILE_PREFIX
// map; adding 'dependency_verify' to both is a one-line change to a file
// outside this ticket's write scope, and neither the map nor its `versionOf`
// helper is exported. So: the DIRECTORY constant is imported rather than
// re-derived (one place for where checklists live), the ten lines below are a
// stopgap, and folding this key into the shared map is the correct follow-up.

const PREFIX = 'dependency-verify.v';

export interface VerifyChecklist {
  /** e.g. `dependency-verify.v1` — what lands in analysis_runs.checklist_version. */
  version: string;
  prompt: string;
}

export class VerifyChecklistMissingError extends Error {
  constructor(dir: string) {
    super(`no "${PREFIX}*.md" checklist asset found in ${dir}`);
    this.name = 'VerifyChecklistMissingError';
  }
}

export function loadVerifyChecklist(dir: string = CHECKLIST_DIR): VerifyChecklist {
  const file = readdirSync(dir)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith('.md'))
    .sort((a, b) => versionOf(a) - versionOf(b))
    .at(-1);
  if (!file) throw new VerifyChecklistMissingError(dir);
  return {
    version: file.replace(/\.md$/, ''),
    prompt: readFileSync(path.join(dir, file), 'utf8'),
  };
}

function versionOf(file: string): number {
  const match = /^dependency-verify\.v(\d+)\.md$/.exec(file);
  return match?.[1] ? Number(match[1]) : 0;
}
