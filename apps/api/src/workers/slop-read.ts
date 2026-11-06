// W25-08: how much of a tree the anti-slop/logging/perf pass reads, and what a
// partial read says about itself.

/**
 * Files read for the anti-slop pass. The reader's default (2,000) cut saleor and
 * outline short on the 0.2.0 install; the reader's 64 MB total-bytes guard is
 * unchanged and still bounds memory.
 */
export const SLOP_MAX_FILES = 20_000;

/** The sentence a partial read writes on its run row, so "cut short" names its cause. */
export function partialReadReason(
  sources: { files: readonly unknown[]; skipped: number; truncated: boolean },
  maxFiles: number,
): string {
  const parts: string[] = [];
  if (sources.truncated) {
    parts.push(
      `the read stopped after ${sources.files.length.toLocaleString('en-US')} files (cap ${maxFiles.toLocaleString('en-US')} files or 64 MB), so files after that were not checked`,
    );
  }
  if (sources.skipped > 0) {
    parts.push(
      `${sources.skipped.toLocaleString('en-US')} file${sources.skipped === 1 ? ' was' : 's were'} skipped for being over 512 KB`,
    );
  }
  return `Partial read: ${parts.join('; ')}. Findings in what was read are real; the rest of the tree was not looked at.`;
}
