import { Registry } from 'prom-client';

// NFR-12: one process-wide registry so every wave registers its own
// counters/gauges/histograms without new plumbing (W1-09 acceptance) -
// module-level singleton, relies on Node's module cache giving every
// importer within the same process the same Registry instance.
export const metricsRegistry = new Registry();
