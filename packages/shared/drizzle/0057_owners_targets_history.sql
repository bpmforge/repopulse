-- W20-24 (UX_TODO DSH-44, DSH-37, DSH-41). All additive.
--
-- plan_items.owner_user_id: who on the team is picking an improvement-plan
-- item up (decision 2026-10-21). Optional, a workspace member, SET NULL when
-- the account goes so the item stays. It is a hand-off, never scored: nothing
-- counts or ranks items per owner.
--
-- file_hotspot_scores: one file's hotspot score over time, written for files
-- that carry an intent (when the intent is saved, and by every snapshot run).
-- M2's per-file list keeps only a repository's top files, so a file that cooled
-- off fell out of it and "did it improve?" could not be answered.
--
-- pr_review_requests: when a reviewer was asked. From the forge's issue events
-- (source 'timeline', exact) or, for a request that appears on a later listing,
-- the pull request's updated time when it was first seen (source 'observed').
-- The review queue measures waiting from here when it is known.
ALTER TABLE "plan_items" ADD COLUMN "owner_user_id" bigint;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_items_workspace_owner_idx" ON "plan_items" USING btree ("workspace_id","owner_user_id") WHERE "owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "file_hotspot_scores" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "file_hotspot_scores_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"path" text NOT NULL,
	"window" text NOT NULL,
	"score" numeric(12, 6) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "file_hotspot_scores" ADD CONSTRAINT "file_hotspot_scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_hotspot_scores" ADD CONSTRAINT "file_hotspot_scores_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_hotspot_scores_workspace_repo_path_idx" ON "file_hotspot_scores" USING btree ("workspace_id","repo_id","path","computed_at");--> statement-breakpoint
CREATE TABLE "pr_review_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pr_review_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"pull_request_id" bigint NOT NULL,
	"reviewer_identity_id" bigint NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "pr_review_requests_pr_reviewer_at_key" UNIQUE("pull_request_id","reviewer_identity_id","requested_at"),
	CONSTRAINT "pr_review_requests_source_check" CHECK ("pr_review_requests"."source" in ('timeline', 'observed'))
);--> statement-breakpoint
ALTER TABLE "pr_review_requests" ADD CONSTRAINT "pr_review_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_requests" ADD CONSTRAINT "pr_review_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_requests" ADD CONSTRAINT "pr_review_requests_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_requests" ADD CONSTRAINT "pr_review_requests_reviewer_identity_id_identities_id_fk" FOREIGN KEY ("reviewer_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pr_review_requests_workspace_reviewer_idx" ON "pr_review_requests" USING btree ("workspace_id","reviewer_identity_id","requested_at");
