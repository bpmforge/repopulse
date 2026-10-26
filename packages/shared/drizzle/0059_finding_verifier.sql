-- W21-03 (gap analysis 2026-10-26: "second model verifies" was not wired). All
-- additive and nullable.
--
-- findings.verified_by_model / verified_by_provider_id / verified_by_connection
-- / verified_at: which model, on which AI connection, gave the second opinion
-- that set verify_status, and when. Until now nothing in production wrote
-- verify_status at all, and the only "verified by" a finding could show was a
-- triage suggestion's. SET NULL so removing a connection keeps the record; its
-- name is kept beside it, as ai_triage_verdicts does.
--
-- findings.verify_reason: the second model's reason, or why no second opinion
-- could be had (no independent connection, the repository not opted in to Tier
-- 3 for an off-network one, the monthly call cap, AI switched off). A
-- contradicting verdict MARKS a finding; it never changes its status.
ALTER TABLE "findings" ADD COLUMN "verified_by_model" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verified_by_provider_id" bigint;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verified_by_connection" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verify_reason" text;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_verified_by_provider_id_llm_providers_id_fk" FOREIGN KEY ("verified_by_provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;
