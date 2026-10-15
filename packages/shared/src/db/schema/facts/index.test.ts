import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import * as schema from './index.js';

describe('facts schema (DATABASE.md §2 Facts)', () => {
  it('exports exactly the ten documented fact tables', () => {
    const tableNames = [
      schema.commits,
      schema.commitFiles,
      schema.pullRequests,
      schema.prReviews,
      schema.prReviewComments,
      schema.prFiles,
      schema.checkRuns,
      schema.deployments,
      schema.releases,
      schema.issues,
    ].map((table) => getTableName(table));

    expect(tableNames).toEqual([
      'commits',
      'commit_files',
      'pull_requests',
      'pr_reviews',
      'pr_review_comments',
      'pr_files',
      'check_runs',
      'deployments',
      'releases',
      'issues',
    ]);
  });
});
