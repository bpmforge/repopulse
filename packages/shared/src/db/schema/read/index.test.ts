import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import * as schema from './index.js';

describe('read-model schema (DATABASE.md §2 Read models & analysis)', () => {
  it('exports exactly the seven documented read-model tables', () => {
    const tableNames = [
      schema.metricSnapshots,
      schema.analysisRuns,
      schema.findings,
      schema.findingEvents,
      schema.reports,
      schema.savedViews,
      schema.egressAudit,
    ].map((table) => getTableName(table));

    expect(tableNames).toEqual([
      'metric_snapshots',
      'analysis_runs',
      'findings',
      'finding_events',
      'reports',
      'saved_views',
      'egress_audit',
    ]);
  });
});
