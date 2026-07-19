import { describe, expect, it } from 'vitest';
import { deltaEnqueueSpec, routeEvent, SUBSCRIBED_EVENTS, type DeltaJobData } from './events.js';

describe('webhook event routing (INGESTION §4)', () => {
  it('subscribes to exactly the §4 event set', () => {
    expect([...SUBSCRIBED_EVENTS]).toEqual([
      'push',
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'workflow_run',
      'check_suite',
      'deployment_status',
      'release',
      'issues',
      'repository',
    ]);
  });

  it('routes every subscribed event to a delta kind', () => {
    for (const e of SUBSCRIBED_EVENTS) expect(routeEvent(e)).not.toBeNull();
  });

  it('collapses the three PR-ish events onto pull_requests', () => {
    expect(routeEvent('pull_request')).toBe('pull_requests');
    expect(routeEvent('pull_request_review')).toBe('pull_requests');
    expect(routeEvent('pull_request_review_comment')).toBe('pull_requests');
  });

  it('ignores an unsubscribed event', () => {
    expect(routeEvent('star')).toBeNull();
  });
});

describe('push coalescing (NFR-10)', () => {
  const base: DeltaJobData = { workspaceId: 1, repoId: 7, repo: 'acme/x', kind: 'push_commits' };

  it('push uses jobId push:{repoId} + a 30s debounce so a burst collapses to one job', () => {
    const spec = deltaEnqueueSpec(base);
    expect(spec.opts.jobId).toBe('push-7');
    expect(spec.opts.delayMs).toBe(30_000);
    // two pushes for the same repo → identical jobId → BullMQ coalesces them
    expect(deltaEnqueueSpec(base).opts.jobId).toBe(spec.opts.jobId);
  });

  it('non-push deltas get a per-repo-per-kind jobId, no debounce', () => {
    const spec = deltaEnqueueSpec({ ...base, kind: 'pull_requests' });
    expect(spec.opts.jobId).toBe('delta-7-pull_requests');
    expect(spec.opts.delayMs).toBeUndefined();
  });
});
