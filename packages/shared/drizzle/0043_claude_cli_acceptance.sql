-- W19-08: the customer-supplied Claude Code CLI option.
-- 1. the new provider kind, and its allowance for no base URL (its endpoint is fixed);
-- 2. a durable record of who accepted which version of the responsibility
--    statement, and when. Rows are never deleted; revoking sets revoked_at.
ALTER TABLE "llm_providers" DROP CONSTRAINT "llm_providers_kind_check";--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_kind_check" CHECK (kind in ('openai_compatible', 'anthropic', 'gemini', 'vertex', 'bedrock', 'copilot', 'openai_subscription', 'claude_cli'));--> statement-breakpoint
ALTER TABLE "llm_providers" DROP CONSTRAINT "llm_providers_base_url_check";--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_base_url_check" CHECK (base_url is not null or kind in ('anthropic', 'gemini', 'bedrock', 'copilot', 'openai_subscription', 'claude_cli'));--> statement-breakpoint
CREATE TABLE "llm_responsibility_acceptances" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_responsibility_acceptances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"topic" text NOT NULL,
	"statement_version" text NOT NULL,
	"statement_sha256" text NOT NULL,
	"accepted_by" bigint,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" bigint,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "llm_responsibility_acceptances_topic_check" CHECK (topic in ('claude_cli')),
	CONSTRAINT "llm_responsibility_acceptances_revoke_check" CHECK ((revoked_at is null and revoked_by is null) or revoked_at is not null)
);
--> statement-breakpoint
ALTER TABLE "llm_responsibility_acceptances" ADD CONSTRAINT "llm_responsibility_acceptances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_responsibility_acceptances" ADD CONSTRAINT "llm_responsibility_acceptances_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_responsibility_acceptances" ADD CONSTRAINT "llm_responsibility_acceptances_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_responsibility_acceptances_workspace_idx" ON "llm_responsibility_acceptances" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_responsibility_acceptances_active_key" ON "llm_responsibility_acceptances" USING btree ("workspace_id","topic") WHERE revoked_at is null;
