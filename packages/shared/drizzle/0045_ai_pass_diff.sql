-- W19-11: an AI pass can review a pull request's diff or a range of commits, not
-- only typed paths. The mode and the refs are kept on the pass so the screen can
-- say what was reviewed. Existing passes are path passes.
ALTER TABLE "ai_pass_runs" ADD COLUMN "mode" text DEFAULT 'paths' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "base_ref" text;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "head_ref" text;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_mode_check" CHECK ("ai_pass_runs"."mode" in ('paths', 'pull_request', 'commit_range'));
