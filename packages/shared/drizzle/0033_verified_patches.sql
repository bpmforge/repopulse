-- Migration 0033 (W18-19, D16): verified patches.
--
-- WHY. A model drafts a fix for one finding; Repo Pulse applies it to the scan
-- snapshot inside the sandbox flow and re-runs that file's rules. Only a patch
-- that clears the finding without a new one is shown; anything else is kept
-- with its reason for an admin. Nothing is ever written to the forge (D9a).
--
-- NUMBERED 0033, not 0032: claude/repopulse-ci-pull adds 0032_ci_tokens. Merge
-- that branch first; this file's snapshot then needs its prevId re-pointed at
-- 0032's id (drizzle-kit check).
--
-- TENANCY. workspace_id on the new table; every read is workspace-filtered.
--
-- ROLLBACK. DROP TABLE "verified_patches"; — patches are derived data, and a
-- finding's patch can be drafted again.
CREATE TABLE "verified_patches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verified_patches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"finding_id" bigint NOT NULL,
	"commit_sha" text NOT NULL,
	"target_dedup_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"reason" text,
	"diff" text,
	"tier" smallint DEFAULT 2 NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"verification_runs" jsonb,
	"requested_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "verified_patches_workspace_finding_commit_key" UNIQUE("workspace_id","finding_id","commit_sha"),
	CONSTRAINT "verified_patches_status_check" CHECK ("verified_patches"."status" in ('pending', 'verified', 'rejected', 'failed')),
	CONSTRAINT "verified_patches_tier_check" CHECK ("verified_patches"."tier" in (2, 3))
);
--> statement-breakpoint
ALTER TABLE "verified_patches" ADD CONSTRAINT "verified_patches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_patches" ADD CONSTRAINT "verified_patches_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_patches" ADD CONSTRAINT "verified_patches_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_patches" ADD CONSTRAINT "verified_patches_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verified_patches_workspace_created_idx" ON "verified_patches" USING btree ("workspace_id","created_at");