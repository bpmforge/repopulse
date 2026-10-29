-- W22-03 (2026-10-29): a fast first pass for the AI judge. Measured on outline:
-- a local 27B model took about 7 minutes per verdict, so a 30-minute run judged
-- 3 rule hits while 162 waited, and most graded rule hits are false positives.
--
-- llm_role_routes: the optional role 'triage_fast' (a smaller, faster model
-- asked first). Not routed by default; with no chain the judge goes straight to
-- the 'triage' route, exactly as before.
--
-- ai_triage_verdicts.pass: which judge pass produced the stored verdict:
-- 'fast' (the quick first look cleared it as a likely false positive) or 'full'
-- (the main triage route). NULL on rows from an AI pass and from before this
-- migration.
ALTER TABLE "llm_role_routes" DROP CONSTRAINT "llm_role_routes_role_check";--> statement-breakpoint
ALTER TABLE "llm_role_routes" ADD CONSTRAINT "llm_role_routes_role_check" CHECK (role in ('security', 'performance', 'code_health', 'best_practices', 'ai_slop', 'test_coverage', 'triage', 'patch', 'triage_fast'));--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD COLUMN "pass" text;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_pass_check" CHECK ("ai_triage_verdicts"."pass" is null or "ai_triage_verdicts"."pass" in ('fast', 'full'));
