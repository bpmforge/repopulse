-- W22-02 (slice 1): the AI judge's evidence packet for a rule hit, captured in
-- the scan-runner while the snapshot exists (C1a: it is deleted after the scan)
-- and stored beside context_lines: the enclosing function, where the names on
-- the flagged lines are defined, and the function's callers with the
-- crossFileGraphReliable flag. It is customer code, so it lives and dies with
-- context_lines (same row, so workspace-scoped by findings.workspace_id; set and
-- replaced with it; cleared by the same retention sweep, findings/context.ts).
ALTER TABLE "findings" ADD COLUMN "context_packet" jsonb;
