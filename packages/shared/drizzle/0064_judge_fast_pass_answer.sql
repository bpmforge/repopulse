-- W22-14 (2026-10-29): keep the quick first look's answer when it escalates.
-- Live on outline the 8B fast model escalated all 4 hits and the 27B main model
-- called all 4 real; the fast answer was thrown away, so how often the two
-- agree could not be measured.
--
-- ai_triage_verdicts.fast_pass: on a 'full' verdict reached after the quick
-- first look escalated, its answer: {verdict, confidence, reason, model, ms},
-- reason one of low_confidence | not_false_positive | rejected | provider_error.
-- NULL everywhere else (fast rows, no triage_fast route, AI-pass rows, older
-- rows). It never feeds the stored verdict or the finding's status.
ALTER TABLE "ai_triage_verdicts" ADD COLUMN "fast_pass" jsonb;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_fast_pass_check" CHECK ("ai_triage_verdicts"."fast_pass" is null or "ai_triage_verdicts"."pass" = 'full');
