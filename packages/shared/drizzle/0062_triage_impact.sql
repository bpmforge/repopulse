-- W22-03 (2026-10-29): the AI judge says how much a REAL performance hit
-- matters. Measured on outline: two copy-in-a-loop hits over small fixed lists
-- (decorator fields per model, editor extensions) were judged real, and fix
-- drafting spent a local model's time on one while riskier hits waited.
--
-- impact: 'material' (grows with data or traffic), 'negligible' (small or
-- bounded input: a fixed list, config, a per-request constant) or 'unknown'.
-- impact_reason: the one-line evidence for it. Both NULL on every other
-- dimension and verdict, and on every row from before this migration.
-- A negligible impact never changes the finding's status or verify_status;
-- it holds back fix drafting and changes the label on screen.
ALTER TABLE "ai_triage_verdicts" ADD COLUMN "impact" text;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD COLUMN "impact_reason" text;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_impact_check" CHECK ("ai_triage_verdicts"."impact" is null or "ai_triage_verdicts"."impact" in ('material', 'negligible', 'unknown'));
