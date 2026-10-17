ALTER TABLE "llm_providers" DROP CONSTRAINT "llm_providers_kind_check";--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_kind_check" CHECK (kind in ('openai_compatible', 'anthropic', 'gemini', 'vertex', 'bedrock', 'copilot', 'openai_subscription'));--> statement-breakpoint
ALTER TABLE "llm_providers" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD COLUMN "probed_at" timestamp with time zone;
