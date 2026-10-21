import { describe, expect, it } from 'vitest';
import { jobTarget } from './index.js';

// W20-22 (UX_TODO ADM-53): a dead-letter row says what its job was for.
describe('jobTarget', () => {
  it('reads the repository and what the job was doing', () => {
    expect(jobTarget({ workspaceId: 1, repoId: 4, entityType: 'pulls' })).toEqual({
      repoId: 4,
      detail: 'pulls',
    });
    expect(jobTarget({ workspaceId: 1, repoId: 4, prNumber: 12, scannerKey: 'semgrep' })).toEqual({
      repoId: 4,
      detail: 'pull request #12 · scanner semgrep',
    });
    expect(jobTarget({ workspaceId: 1, reportId: 33 })).toEqual({
      repoId: null,
      detail: 'report #33',
    });
  });

  it('is empty for a payload it cannot read', () => {
    expect(jobTarget(null)).toEqual({ repoId: null, detail: null });
    expect(jobTarget({ repoId: 0 })).toEqual({ repoId: null, detail: null });
  });
});
