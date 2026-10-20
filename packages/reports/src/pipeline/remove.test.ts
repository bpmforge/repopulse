import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeReportArtifacts, reportDir } from './render.js';

// W20-19 (UX_TODO ADM-72; decision 2026-10-20): deleting a report removes its
// files — and only files inside that report's own directory.

describe('removeReportArtifacts', () => {
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rp-remove-'));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('removes the report’s files and its directory', async () => {
    const dir = reportDir(dataDir, 3, 11);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.pdf'), 'pdf');
    await writeFile(join(dir, 'data.json'), '{}');
    const removed = await removeReportArtifacts({
      id: 11,
      workspaceId: 3,
      uris: [`file://${join(dir, 'report.pdf')}`, join(dir, 'data.json'), null],
    });
    expect(removed).toBe(2);
    await expect(stat(dir)).rejects.toThrow();
  });

  it('never touches a file outside that report’s directory', async () => {
    const other = reportDir(dataDir, 3, 12);
    await mkdir(other, { recursive: true });
    const stray = join(dataDir, 'stray.pdf');
    await writeFile(join(other, 'report.pdf'), 'pdf');
    await writeFile(stray, 'x');
    const removed = await removeReportArtifacts({
      id: 11,
      workspaceId: 3,
      uris: [`file://${join(other, 'report.pdf')}`, `file://${stray}`],
    });
    expect(removed).toBe(0);
    await expect(stat(join(other, 'report.pdf'))).resolves.toBeDefined();
    await expect(stat(stray)).resolves.toBeDefined();
  });

  it('counts nothing for files already gone', async () => {
    const dir = reportDir(dataDir, 3, 13);
    expect(
      await removeReportArtifacts({ id: 13, workspaceId: 3, uris: [join(dir, 'report.pdf')] }),
    ).toBe(0);
  });
});
