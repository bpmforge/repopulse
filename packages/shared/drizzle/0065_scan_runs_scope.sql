-- W23-01 (2026-10-31): "up to date" short-circuit for weekly and manual scans.
--
-- scan_runs.scope: what the run did. 'full' (every run written before this
-- column, and every run that read the tree), 'incremental' (a delta over a
-- baseline; reserved for the W23 incremental modes), 'skipped' (nothing was
-- scanned because an earlier run at the same commit, with the same tool and
-- data versions, already answered it). NOT NULL DEFAULT 'full' so existing rows
-- and every writer that has not heard of the column keep their meaning.
-- scan_runs.base_run_id: the run a skipped/incremental row stands on. No FK on
-- purpose: it is provenance, not integrity, and must not block deleting a run.
-- scan_runs.data_version: the scanner's data stamp (advisory DB build etc.),
-- NULL when the scanner declares none. Tenancy is unchanged: workspace_id
-- stays NOT NULL on the row and every reader filters on it.
ALTER TABLE "scan_runs" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "base_run_id" bigint;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "data_version" text;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_scope_check" CHECK ("scan_runs"."scope" in ('full', 'incremental', 'skipped'));
