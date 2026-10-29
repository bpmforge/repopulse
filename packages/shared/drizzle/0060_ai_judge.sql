-- W22-03: the AI judges every rule hit after each scan (CLOSE_THE_LOOP.md,
-- owner decisions 1 and 2). A judge run is an ai_pass_runs row (mode 'judge',
-- trigger 'after_scan') so its verdicts reference a run, its calls are
-- attributed on the egress audit, and an admin can cancel it like any pass.
--
-- budget: what bounds the run. 'time' = every routed model is local, and the
-- run spends wall-clock minutes of the workspace's daily judge budget; these
-- calls are NOT on the monthly call cap, which stays for hosted links
-- ('calls', the default and every pre-existing row).
--
-- The one-active-pass index no longer covers judge runs: a judge run after a
-- scan must not block a person's pass, nor a person's pass the judge. Judge
-- runs get their own one-active index per repository.
--
-- ai_pass_settings.judge_minutes_per_day: the workspace's time budget for
-- local judging over a rolling 24 hours. NULL = the server default
-- (AI_JUDGE_MINUTES_PER_DAY, 240). 0 stops local judging.
ALTER TABLE "ai_pass_runs" ADD COLUMN "budget" text DEFAULT 'calls' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_budget_check" CHECK ("ai_pass_runs"."budget" in ('calls', 'time'));--> statement-breakpoint
ALTER TABLE "ai_pass_runs" DROP CONSTRAINT "ai_pass_runs_mode_check";--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_mode_check" CHECK ("ai_pass_runs"."mode" in ('paths', 'pull_request', 'commit_range', 'second_opinion', 'judge'));--> statement-breakpoint
ALTER TABLE "ai_pass_runs" DROP CONSTRAINT "ai_pass_runs_trigger_check";--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_trigger_check" CHECK ("ai_pass_runs"."trigger" in ('manual', 'scheduled', 'after_scan'));--> statement-breakpoint
DROP INDEX "ai_pass_runs_one_active_key";--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pass_runs_one_active_key" ON "ai_pass_runs" USING btree ("workspace_id","repo_id") WHERE status in ('pending', 'running') and mode <> 'judge';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pass_runs_one_active_judge_key" ON "ai_pass_runs" USING btree ("workspace_id","repo_id") WHERE status in ('pending', 'running') and mode = 'judge';--> statement-breakpoint
ALTER TABLE "ai_pass_settings" ADD COLUMN "judge_minutes_per_day" integer;--> statement-breakpoint
ALTER TABLE "ai_pass_settings" ADD CONSTRAINT "ai_pass_settings_judge_minutes_check" CHECK ("ai_pass_settings"."judge_minutes_per_day" is null or "ai_pass_settings"."judge_minutes_per_day" between 0 and 1440);
