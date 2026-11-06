-- W25-07 (2026-11-06): incremental re-review of a repository pass (mode 'paths').
--
-- ai_pass_runs.file_hashes: path -> sha-256 of the content each file had when
-- the pass read it. The next pass over the same paths sends the model only the
-- files whose hash differs, and carries the earlier findings in the rest
-- forward on evidence. NULL on diff-mode rows and on every row written before
-- this column (those make the next pass a full one).
-- Tenancy is unchanged: workspace_id stays NOT NULL and every reader filters on it.
ALTER TABLE "ai_pass_runs" ADD COLUMN "file_hashes" jsonb;
