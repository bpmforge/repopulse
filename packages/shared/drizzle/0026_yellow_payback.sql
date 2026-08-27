CREATE TABLE "llm_providers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_providers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"model" text NOT NULL,
	"credential_ciphertext" "bytea",
	"credential_iv" "bytea",
	"key_version" integer,
	"credential_fingerprint" text,
	"headers" jsonb,
	"allow_public_host" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_workspace_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "llm_providers_kind_check" CHECK (kind in ('openai_compatible', 'anthropic', 'vertex', 'bedrock', 'copilot', 'openai_subscription')),
	CONSTRAINT "llm_providers_base_url_check" CHECK (base_url is not null or kind in ('anthropic', 'bedrock', 'copilot', 'openai_subscription')),
	CONSTRAINT "llm_providers_credential_check" CHECK ((credential_ciphertext is null and credential_iv is null and key_version is null and credential_fingerprint is null) or (credential_ciphertext is not null and credential_iv is not null and key_version is not null and credential_fingerprint is not null))
);
--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_providers_workspace_id_idx" ON "llm_providers" USING btree ("workspace_id");