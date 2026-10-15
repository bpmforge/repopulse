CREATE TABLE "ci_tokens" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ci_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scope" text DEFAULT 'pr_findings:read' NOT NULL,
	"repo_ids" bigint[] NOT NULL,
	"created_by" bigint,
	"created_by_login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" bigint,
	CONSTRAINT "ci_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "ci_tokens_scope_check" CHECK ("ci_tokens"."scope" in ('pr_findings:read')),
	CONSTRAINT "ci_tokens_repo_ids_nonempty_check" CHECK (cardinality("ci_tokens"."repo_ids") > 0)
);
--> statement-breakpoint
ALTER TABLE "ci_tokens" ADD CONSTRAINT "ci_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_tokens" ADD CONSTRAINT "ci_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_tokens" ADD CONSTRAINT "ci_tokens_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_tokens_workspace_idx" ON "ci_tokens" USING btree ("workspace_id");