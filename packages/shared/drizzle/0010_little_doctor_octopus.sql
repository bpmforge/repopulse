-- W6-05 (DATABASE.md D9): analysis passes and finding verification.
--
-- ROLLBACK:
--   ALTER TABLE findings DROP CONSTRAINT findings_verify_status_check;
--   ALTER TABLE findings DROP COLUMN verify_status;
--   ALTER TABLE analysis_runs DROP CONSTRAINT analysis_runs_pass_kind_check;
--   ALTER TABLE analysis_runs DROP COLUMN parent_run_id;
--   ALTER TABLE analysis_runs DROP COLUMN pass_kind;
--
-- Rolling back LOSES which findings a second model confirmed or contradicted.
-- Those judgements cannot be recomputed without re-running the verify pass
-- against the same models, so export findings.verify_status first if the data
-- matters.

ALTER TABLE "analysis_runs" ADD COLUMN "pass_kind" text DEFAULT 'find' NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "parent_run_id" bigint;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verify_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_pass_kind_check" CHECK ("analysis_runs"."pass_kind" in ('find', 'verify', 'challenge', 'synthesize', 'narrate', 'plan'));--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_verify_status_check" CHECK ("findings"."verify_status" in ('unverified', 'confirmed', 'contradicted'));