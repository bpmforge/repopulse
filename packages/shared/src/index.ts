export const packageName = '@repopulse/shared';

export * from './db/index.js';
export * from './testing/index.js';
export * from './logger/index.js';
export * from './metrics/index.js';
// URL view-state contract (DASHBOARD §1). Also published as the runtime-safe
// subpath `@repopulse/shared/url-state` — the one shared module apps/web may
// value-import (it has zero DB/server coupling); the barrel stays type-only.
export * from './urlState.js';
