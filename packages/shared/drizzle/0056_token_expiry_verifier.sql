-- W20-25 (UX_TODO ADM-50, X-10). All additive and nullable.
--
-- forge_connections.token_owner_login / token_expires_at / token_checked_at:
-- the forge account a connection's token belongs to and when it expires, read
-- from the forge at connect time (the nightly sweep reads it once for an older
-- connection). The token itself is never stored anywhere new.
--
-- ai_triage_verdicts.llm_provider_id / connection_name: which AI connection
-- answered, beside the model the row already records. Backfilled from the
-- route the gateway recorded, where that connection is still in the workspace.
ALTER TABLE "forge_connections" ADD COLUMN "token_owner_login" text;--> statement-breakpoint
ALTER TABLE "forge_connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forge_connections" ADD COLUMN "token_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD COLUMN "llm_provider_id" bigint;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD COLUMN "connection_name" text;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_llm_provider_id_llm_providers_id_fk" FOREIGN KEY ("llm_provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "ai_triage_verdicts" v SET "connection_name" = v."route" ->> 'providerName' WHERE v."route" ->> 'providerName' IS NOT NULL;--> statement-breakpoint
UPDATE "ai_triage_verdicts" v SET "llm_provider_id" = p."id" FROM "llm_providers" p WHERE p."workspace_id" = v."workspace_id" AND (v."route" ->> 'providerId') ~ '^[0-9]+$' AND p."id" = (v."route" ->> 'providerId')::bigint;
