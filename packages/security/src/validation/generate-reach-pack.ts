import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { REACH_RULEPACK_DIR, REACH_RULEPACK_FILE } from './symbol-reachability.js';
import { renderReachPack } from './symbols.js';

// Rewrites rulepacks/reachability/bpm-reach.v1.yaml from the symbol catalogue
// (W18-46): `pnpm --filter @repopulse/security reach:generate`.
writeFileSync(path.join(REACH_RULEPACK_DIR, REACH_RULEPACK_FILE), renderReachPack());
process.stdout.write(`wrote ${REACH_RULEPACK_FILE}\n`);
