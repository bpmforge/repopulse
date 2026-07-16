-- Migration 0001 (W1-02): fact tables + read-model tables.
-- Rollback note (PLAYBOOK §Migration tickets — Drizzle has no auto-down):
--   DROP TABLE "egress_audit", "saved_views", "reports", "finding_events",
--     "findings", "analysis_runs", "metric_snapshots", "issues", "releases",
--     "deployments", "check_runs", "pr_files", "pr_reviews", "pull_requests",
--     "commit_files", "commits" CASCADE;
--   Base migration on an empty schema (pre-launch, no production data) —
--   full rollback is a full drop, no data to preserve. Run migration 0002's
--   rollback (DROP ROLE repopulse_app) first if it was already applied,
--   since it's not strictly dependent but keeps teardown order sane.
CREATE TABLE "commits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"sha" text NOT NULL,
	"author_identity_id" bigint NOT NULL,
	"committer_identity_id" bigint NOT NULL,
	"authored_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"message_head" text NOT NULL,
	"is_revert_heuristic" boolean NOT NULL,
	"additions" integer,
	"deletions" integer,
	"files_count" integer,
	"stats_source" text,
	CONSTRAINT "commits_repo_sha_key" UNIQUE("repo_id","sha"),
	CONSTRAINT "commits_stats_source_check" CHECK ("commits"."stats_source" is null or "commits"."stats_source" in ('detail', 'stats_api', 'graphql'))
);
--> statement-breakpoint
CREATE TABLE "commit_files" (
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"commit_id" bigint NOT NULL,
	"path" text NOT NULL,
	"additions" integer NOT NULL,
	"deletions" integer NOT NULL,
	"status" text NOT NULL,
	"previous_path" text,
	CONSTRAINT "commit_files_commit_id_path_pk" PRIMARY KEY("commit_id","path"),
	CONSTRAINT "commit_files_status_check" CHECK ("commit_files"."status" in ('added', 'modified', 'removed', 'renamed'))
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pull_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"forge_pr_id" text NOT NULL,
	"title" text NOT NULL,
	"author_identity_id" bigint NOT NULL,
	"state" text NOT NULL,
	"is_draft" boolean NOT NULL,
	"is_bot" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"merged_by_identity_id" bigint,
	"base_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"additions" integer NOT NULL,
	"deletions" integer NOT NULL,
	"changed_files" integer NOT NULL,
	"first_review_at" timestamp with time zone,
	"first_approval_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"last_activity_kind" text,
	CONSTRAINT "pull_requests_repo_number_key" UNIQUE("repo_id","number"),
	CONSTRAINT "pull_requests_state_check" CHECK ("pull_requests"."state" in ('open', 'closed', 'merged'))
);
--> statement-breakpoint
CREATE TABLE "pr_reviews" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pr_reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"pull_request_id" bigint NOT NULL,
	"forge_review_id" text NOT NULL,
	"reviewer_identity_id" bigint NOT NULL,
	"state" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pr_reviews_pull_request_forge_review_key" UNIQUE("pull_request_id","forge_review_id"),
	CONSTRAINT "pr_reviews_state_check" CHECK ("pr_reviews"."state" in ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'))
);
--> statement-breakpoint
CREATE TABLE "pr_files" (
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"pull_request_id" bigint NOT NULL,
	"path" text NOT NULL,
	"additions" integer NOT NULL,
	"deletions" integer NOT NULL,
	"change_type" text NOT NULL,
	CONSTRAINT "pr_files_pull_request_id_path_pk" PRIMARY KEY("pull_request_id","path")
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "check_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"forge_run_id" text NOT NULL,
	"kind" text NOT NULL,
	"workflow_name" text,
	"head_sha" text NOT NULL,
	"pull_request_id" bigint,
	"status" text NOT NULL,
	"conclusion" text,
	"run_attempt" smallint NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" bigint,
	CONSTRAINT "check_runs_repo_kind_forge_run_attempt_key" UNIQUE("repo_id","kind","forge_run_id","run_attempt"),
	CONSTRAINT "check_runs_kind_check" CHECK ("check_runs"."kind" in ('check_run', 'workflow_run'))
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deployments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"forge_deployment_id" text NOT NULL,
	"environment" text NOT NULL,
	"sha" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"latest_status" text NOT NULL,
	"status_updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deployments_repo_forge_deployment_key" UNIQUE("repo_id","forge_deployment_id")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "releases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"forge_release_id" text NOT NULL,
	"tag" text NOT NULL,
	"name" text,
	"is_draft" boolean NOT NULL,
	"is_prerelease" boolean NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "releases_repo_forge_release_key" UNIQUE("repo_id","forge_release_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issues_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"author_identity_id" bigint NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"reopened_count" smallint DEFAULT 0 NOT NULL,
	"is_pull_request" boolean NOT NULL,
	CONSTRAINT "issues_repo_number_key" UNIQUE("repo_id","number")
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "metric_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint,
	"metric_key" text NOT NULL,
	"window" text NOT NULL,
	"dims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value" numeric(18, 6) NOT NULL,
	"numerator" numeric(18, 6),
	"denominator" numeric(18, 6),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analysis_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"pull_request_id" bigint,
	"tier" smallint NOT NULL,
	"dimension" text NOT NULL,
	"checklist_version" text NOT NULL,
	"model_id" text NOT NULL,
	"status" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(10, 4),
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "analysis_runs_tier_check" CHECK ("analysis_runs"."tier" in (2, 3)),
	CONSTRAINT "analysis_runs_status_check" CHECK ("analysis_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "findings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"analysis_run_id" bigint NOT NULL,
	"pull_request_id" bigint,
	"dimension" text NOT NULL,
	"severity" smallint NOT NULL,
	"confidence" smallint NOT NULL,
	"title" text NOT NULL,
	"file" text NOT NULL,
	"line_start" integer NOT NULL,
	"line_end" integer NOT NULL,
	"evidence" text NOT NULL,
	"recommendation" text NOT NULL,
	"tier" smallint NOT NULL,
	"dedup_key" text NOT NULL,
	"status" text NOT NULL,
	"dismiss_reason" text,
	"status_changed_by" bigint,
	"status_changed_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "findings_workspace_repo_dedup_key" UNIQUE("workspace_id","repo_id","dedup_key"),
	CONSTRAINT "findings_dimension_check" CHECK ("findings"."dimension" in ('code_health', 'security', 'performance', 'test_coverage')),
	CONSTRAINT "findings_severity_check" CHECK ("findings"."severity" between 1 and 5),
	CONSTRAINT "findings_confidence_check" CHECK ("findings"."confidence" between 1 and 5),
	CONSTRAINT "findings_status_check" CHECK ("findings"."status" in ('open', 'confirmed', 'dismissed', 'resolved', 'wont_fix'))
);
--> statement-breakpoint
CREATE TABLE "finding_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finding_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"finding_id" bigint NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor" bigint,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"type" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"html_uri" text,
	"pdf_uri" text,
	"generated_by" bigint NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_type_check" CHECK ("reports"."type" in ('repo_health', 'org_exec', 'security_posture', 'delivery_dora')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('queued', 'running', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "saved_views_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"share_slug" text,
	"is_default_for_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_share_slug_unique" UNIQUE("share_slug")
);
--> statement-breakpoint
CREATE TABLE "egress_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "egress_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"pull_request_id" bigint,
	"analysis_run_id" bigint NOT NULL,
	"initiator_user_id" bigint NOT NULL,
	"model_id" text NOT NULL,
	"bytes_sent" integer NOT NULL,
	"tokens_sent" integer NOT NULL,
	"tokens_received" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_author_identity_id_identities_id_fk" FOREIGN KEY ("author_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_committer_identity_id_identities_id_fk" FOREIGN KEY ("committer_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commit_files" ADD CONSTRAINT "commit_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commit_files" ADD CONSTRAINT "commit_files_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commit_files" ADD CONSTRAINT "commit_files_commit_id_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_identity_id_identities_id_fk" FOREIGN KEY ("author_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merged_by_identity_id_identities_id_fk" FOREIGN KEY ("merged_by_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_reviewer_identity_id_identities_id_fk" FOREIGN KEY ("reviewer_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_files" ADD CONSTRAINT "pr_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_files" ADD CONSTRAINT "pr_files_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_files" ADD CONSTRAINT "pr_files_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_author_identity_id_identities_id_fk" FOREIGN KEY ("author_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_actor_users_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD CONSTRAINT "egress_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD CONSTRAINT "egress_audit_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD CONSTRAINT "egress_audit_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD CONSTRAINT "egress_audit_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD CONSTRAINT "egress_audit_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commits_workspace_id_idx" ON "commits" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commits_workspace_repo_author_authored_idx" ON "commits" USING btree ("workspace_id","repo_id","author_identity_id","authored_at");--> statement-breakpoint
CREATE INDEX "commit_files_workspace_id_idx" ON "commit_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commit_files_workspace_repo_path_commit_idx" ON "commit_files" USING btree ("workspace_id","repo_id","path","commit_id");--> statement-breakpoint
CREATE INDEX "pull_requests_workspace_repo_state_merged_idx" ON "pull_requests" USING btree ("workspace_id","repo_id","state","merged_at");--> statement-breakpoint
CREATE INDEX "pull_requests_workspace_repo_last_activity_idx" ON "pull_requests" USING btree ("workspace_id","repo_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "pull_requests_workspace_author_state_idx" ON "pull_requests" USING btree ("workspace_id","author_identity_id","state");--> statement-breakpoint
CREATE INDEX "pr_reviews_workspace_reviewer_submitted_idx" ON "pr_reviews" USING btree ("workspace_id","reviewer_identity_id","submitted_at");--> statement-breakpoint
CREATE INDEX "pr_files_workspace_id_idx" ON "pr_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "check_runs_workspace_repo_workflow_completed_idx" ON "check_runs" USING btree ("workspace_id","repo_id","workflow_name","completed_at");--> statement-breakpoint
CREATE INDEX "deployments_workspace_id_idx" ON "deployments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "releases_workspace_id_idx" ON "releases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "issues_workspace_id_idx" ON "issues" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "metric_snapshots_workspace_repo_key_window_computed_idx" ON "metric_snapshots" USING btree ("workspace_id","repo_id","metric_key","window","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "metric_snapshots_org_rollup_idx" ON "metric_snapshots" USING btree ("workspace_id","metric_key","window","computed_at" DESC NULLS LAST) WHERE "metric_snapshots"."repo_id" is null;--> statement-breakpoint
CREATE INDEX "analysis_runs_workspace_id_idx" ON "analysis_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "findings_workspace_repo_dimension_severity_status_idx" ON "findings" USING btree ("workspace_id","repo_id","dimension","severity","status");--> statement-breakpoint
CREATE INDEX "finding_events_workspace_id_idx" ON "finding_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "finding_events_finding_id_idx" ON "finding_events" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "reports_workspace_id_idx" ON "reports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "saved_views_workspace_id_idx" ON "saved_views" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "egress_audit_workspace_id_idx" ON "egress_audit" USING btree ("workspace_id");