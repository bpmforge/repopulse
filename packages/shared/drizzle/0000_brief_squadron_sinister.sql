-- Migration 0000 (W1-01): tenancy/identity/sync-machinery core schema.
-- Rollback note (PLAYBOOK §Migration tickets — Drizzle has no auto-down):
--   DROP TABLE "job_failure", "webhook_delivery", "forge_etag", "sync_cursors",
--     "repos", "identities", "forge_connections", "workspace_members", "users",
--     "workspaces" CASCADE;
--   Base migration on an empty schema — full rollback is a full drop, no data
--   to preserve. Safe as a single step (no expand/contract needed pre-launch).
CREATE TABLE "workspaces" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workspaces_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"forge_user_id" text NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_forge_user_id_unique" UNIQUE("forge_user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "forge_connections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "forge_connections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"auth_kind" text NOT NULL,
	"credential_ciphertext" "bytea" NOT NULL,
	"credential_iv" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"app_installation_id" text,
	"webhook_secret_ciphertext" "bytea",
	"status" text NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_connections_provider_check" CHECK ("forge_connections"."provider" in ('github', 'gitea')),
	CONSTRAINT "forge_connections_auth_kind_check" CHECK ("forge_connections"."auth_kind" in ('pat', 'app'))
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "identities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"forge_login" text NOT NULL,
	"forge_user_id" text,
	"display_name" text NOT NULL,
	"user_id" bigint,
	"is_bot" boolean DEFAULT false NOT NULL,
	"merged_into_id" bigint,
	CONSTRAINT "identities_workspace_provider_login_key" UNIQUE("workspace_id","provider","forge_login"),
	CONSTRAINT "identities_provider_check" CHECK ("identities"."provider" in ('github', 'gitea'))
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"connection_id" bigint NOT NULL,
	"forge_repo_id" text NOT NULL,
	"org" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"is_private" boolean NOT NULL,
	"is_archived" boolean NOT NULL,
	"sync_status" text NOT NULL,
	"backfill_pct" smallint DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"tier2_auto" boolean NOT NULL,
	"tier3_opt_in" boolean DEFAULT false NOT NULL,
	"pushed_at" timestamp with time zone,
	CONSTRAINT "repos_workspace_connection_forge_repo_key" UNIQUE("workspace_id","connection_id","forge_repo_id"),
	CONSTRAINT "repos_sync_status_check" CHECK ("repos"."sync_status" in ('pending_backfill', 'backfilling', 'live', 'error', 'paused_budget', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"entity_type" text NOT NULL,
	"cursor_value" text,
	"backfill_done" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_repo_id_entity_type_pk" PRIMARY KEY("repo_id","entity_type"),
	CONSTRAINT "sync_cursors_entity_type_check" CHECK ("sync_cursors"."entity_type" in ('commits', 'prs', 'reviews', 'pr_files', 'checks', 'issues', 'releases', 'deployments', 'workflow_runs'))
);
--> statement-breakpoint
CREATE TABLE "forge_etag" (
	"connection_id" bigint NOT NULL,
	"workspace_id" bigint NOT NULL,
	"installation_id" text,
	"endpoint_key" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_status" smallint,
	"body_digest" text,
	"cached_body" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_etag_connection_id_endpoint_key_pk" PRIMARY KEY("connection_id","endpoint_key")
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_delivery_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"connection_id" bigint NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"repo_full_name" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_digest" text NOT NULL,
	CONSTRAINT "webhook_delivery_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "job_failure" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_failure_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"queue" text NOT NULL,
	"job_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_connections" ADD CONSTRAINT "forge_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_connections" ADD CONSTRAINT "forge_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_merged_into_id_identities_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_connection_id_forge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forge_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_etag" ADD CONSTRAINT "forge_etag_connection_id_forge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forge_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_etag" ADD CONSTRAINT "forge_etag_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_connection_id_forge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forge_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_failure" ADD CONSTRAINT "job_failure_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "forge_connections_workspace_id_idx" ON "forge_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "identities_workspace_id_idx" ON "identities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "repos_workspace_id_idx" ON "repos" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sync_cursors_workspace_id_idx" ON "sync_cursors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "forge_etag_workspace_id_idx" ON "forge_etag" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhook_delivery_workspace_id_idx" ON "webhook_delivery" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "job_failure_workspace_id_idx" ON "job_failure" USING btree ("workspace_id");