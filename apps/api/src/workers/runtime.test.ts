import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { isForeignKeyViolation, repoOfJob, skipRemovedRepoJobs } from './runtime.js';

// W20-22: a job queued for a repository purged under it ends as skipped
// instead of retrying into the dead-letter queue on the repo foreign key.

const fkError = () => Object.assign(new Error('insert violates foreign key'), { code: '23503' });
const job = (data: unknown) => ({ data }) as Job;

describe('skipRemovedRepoJobs', () => {
  it('recognises a foreign-key violation, also when wrapped', () => {
    expect(isForeignKeyViolation(fkError())).toBe(true);
    expect(isForeignKeyViolation(new Error('wrapped', { cause: fkError() }))).toBe(true);
    expect(isForeignKeyViolation(new Error('timeout'))).toBe(false);
    expect(repoOfJob({ workspaceId: 1, repoId: 2, x: 1 })).toEqual({ workspaceId: 1, repoId: 2 });
    expect(repoOfJob({ workspaceId: 1 })).toBeNull();
  });

  it('skips a job whose repository is gone', async () => {
    const exists = vi.fn(() => Promise.resolve(false));
    const wrapped = skipRemovedRepoJobs(() => Promise.reject(fkError()), exists);
    await expect(wrapped(job({ workspaceId: 1, repoId: 9 }))).resolves.toEqual({
      skipped: 'repository was removed',
    });
    expect(exists).toHaveBeenCalledWith(1, 9);
  });

  it('still fails when the repository exists, or the error is something else', async () => {
    const exists = vi.fn(() => Promise.resolve(true));
    await expect(
      skipRemovedRepoJobs(
        () => Promise.reject(fkError()),
        exists,
      )(job({ workspaceId: 1, repoId: 9 })),
    ).rejects.toThrow('foreign key');
    const missing = vi.fn(() => Promise.resolve(false));
    await expect(
      skipRemovedRepoJobs(
        () => Promise.reject(new Error('timeout')),
        missing,
      )(job({ workspaceId: 1, repoId: 9 })),
    ).rejects.toThrow('timeout');
    expect(missing).not.toHaveBeenCalled();
  });

  it('passes a result through untouched', async () => {
    const wrapped = skipRemovedRepoJobs(
      () => Promise.resolve({ ok: 1 }),
      () => Promise.resolve(true),
    );
    await expect(wrapped(job({}))).resolves.toEqual({ ok: 1 });
  });
});
