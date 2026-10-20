-- Migration 0051 (W20-18): product decisions of 2026-10-20 on the AI layer and
-- findings (UX_TODO X-08, AI-14, AI-53, AI-77).
--
-- TENANCY. Every change is a new column on an existing tenant-scoped table
-- (workspace_id indexed); nothing here adds a table.

-- X-08: an optional link to the issue tracking a finding (Jira, Linear, ...).
-- http/https only, checked here as well as in the API, so a javascript: or
-- data: URL can never be stored and rendered as a link.
-- ROLLBACK. ALTER TABLE "findings" DROP COLUMN "external_ticket_url";
ALTER TABLE "findings" ADD COLUMN "external_ticket_url" text;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_external_ticket_url_check" CHECK ("findings"."external_ticket_url" is null or ("findings"."external_ticket_url" ~* '^https?://[^[:space:]]+$' and length("findings"."external_ticket_url") <= 2048));--> statement-breakpoint
-- AI-14: a second opinion is a triage suggestion from another model about the
-- same finding, pointing at the suggestion it checks. It is not answered on its
-- own, so it is left out of the one-unanswered-suggestion-per-finding index.
-- It runs as an ai_pass_runs row (mode 'second_opinion'), so it counts toward
-- the daily pass limit like any pass.
-- ROLLBACK. ALTER TABLE "ai_triage_verdicts" DROP COLUMN "second_opinion_of";
ALTER TABLE "ai_triage_verdicts" ADD COLUMN "second_opinion_of" bigint;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_second_opinion_of_fk" FOREIGN KEY ("second_opinion_of") REFERENCES "public"."ai_triage_verdicts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "ai_triage_verdicts_one_open_key";--> statement-breakpoint
CREATE UNIQUE INDEX "ai_triage_verdicts_one_open_key" ON "ai_triage_verdicts" USING btree ("finding_id") WHERE decision is null and second_opinion_of is null;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" DROP CONSTRAINT "ai_pass_runs_mode_check";--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_mode_check" CHECK ("ai_pass_runs"."mode" in ('paths', 'pull_request', 'commit_range', 'second_opinion'));--> statement-breakpoint
-- AI-53: a run window for a scheduled pass, in whole hours of the SERVER's
-- time zone (start inclusive, end exclusive; end before start wraps past
-- midnight). Both NULL = any time, as before.
-- ROLLBACK. ALTER TABLE "ai_pass_schedules" DROP COLUMN "window_start_hour", DROP COLUMN "window_end_hour";
ALTER TABLE "ai_pass_schedules" ADD COLUMN "window_start_hour" smallint;--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD COLUMN "window_end_hour" smallint;--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_window_check" CHECK (("ai_pass_schedules"."window_start_hour" is null and "ai_pass_schedules"."window_end_hour" is null) or ("ai_pass_schedules"."window_start_hour" between 0 and 23 and "ai_pass_schedules"."window_end_hour" between 0 and 23 and "ai_pass_schedules"."window_start_hour" <> "ai_pass_schedules"."window_end_hour"));--> statement-breakpoint
-- AI-77: the workspace-wide "AI off" switch. Off stops AI passes (manual and
-- scheduled), second opinions and verified-fix drafts alike.
-- ROLLBACK. ALTER TABLE "ai_pass_settings" DROP COLUMN "ai_paused", DROP COLUMN "ai_paused_by", DROP COLUMN "ai_paused_at";
ALTER TABLE "ai_pass_settings" ADD COLUMN "ai_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_pass_settings" ADD COLUMN "ai_paused_by" bigint;--> statement-breakpoint
ALTER TABLE "ai_pass_settings" ADD COLUMN "ai_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_pass_settings" ADD CONSTRAINT "ai_pass_settings_ai_paused_by_users_id_fk" FOREIGN KEY ("ai_paused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
