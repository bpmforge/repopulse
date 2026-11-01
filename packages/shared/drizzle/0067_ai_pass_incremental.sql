-- W23-07 (2026-10-31): incremental re-review of a pull request on a new push.
--
-- ai_pass_runs.scope: what the review did. 'full' (every row written before this
-- column) or 'incremental' (only the hunks changed since the base run's head
-- went to the model; surviving findings were carried forward).
-- ai_pass_runs.base_run_id: the earlier pass an incremental row stands on. No FK
-- on purpose: provenance, not integrity; it must not block deleting a pass.
-- ai_pass_runs.prompt_version: the specialists' checklist versions the pass ran
-- with ("security@v1+performance@v3+..."), so a later push is only reviewed
-- incrementally when the earlier answer was given by the same prompts.
-- Tenancy is unchanged: workspace_id stays NOT NULL and every reader filters on it.
ALTER TABLE "ai_pass_runs" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "base_run_id" bigint;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_scope_check" CHECK ("ai_pass_runs"."scope" in ('full', 'incremental'));
