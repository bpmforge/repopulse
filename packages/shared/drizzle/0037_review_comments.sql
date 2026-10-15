-- Migration 0037 (W18-23): inline review comments, anchors only.
--
-- WHY. The AI-reviewer metrics (METRICS.md §5) need to know which lines a
-- review bot commented on and whether a later push changed them. pr_reviews
-- holds only review-level state; nothing stored the per-line comments. The
-- comment BODY is deliberately not a column — the metrics never read it.
--
-- pull_requests.review_comments_observed_at records WHEN a PR's comments were
-- fetched (null = never). §5 reads comment metrics only over PRs where it is
-- set, so a PR enriched before this migration reads as "no line data", not as
-- "zero comments"; and an anchor is final only when fetched after the close.
--
-- sync_cursors_entity_type_check gains 'review_comments', so a token refused
-- the comments endpoint is recorded like every other enrichment refusal
-- (W17-38) instead of reading as "no comments".
--
-- NUMBERING. 0037 was assigned by the W18 lead so parallel branches do not
-- collide; the journal idx is whatever the merge order makes it.
--
-- TENANCY. workspace_id NOT NULL, FK'd, and leading the only index.
--
-- ROLLBACK. DROP TABLE "pr_review_comments"; ALTER TABLE "pull_requests" DROP
-- COLUMN "review_comments_observed_at"; delete sync_cursors rows with
-- entity_type 'review_comments' and restore the previous CHECK list. The
-- AI-reviewer screen then shows review-level counts only.
CREATE TABLE "pr_review_comments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pr_review_comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"pull_request_id" bigint NOT NULL,
	"forge_comment_id" text NOT NULL,
	"forge_review_id" text,
	"author_identity_id" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"path" text NOT NULL,
	"subject_type" text NOT NULL,
	"is_reply" boolean NOT NULL,
	"original_start_line" integer,
	"original_line" integer,
	"current_line" integer,
	"original_commit_sha" text NOT NULL,
	"commit_sha" text NOT NULL,
	CONSTRAINT "pr_review_comments_pull_request_forge_comment_key" UNIQUE("pull_request_id","forge_comment_id"),
	CONSTRAINT "pr_review_comments_subject_type_check" CHECK ("pr_review_comments"."subject_type" in ('line', 'file'))
);
--> statement-breakpoint
ALTER TABLE "sync_cursors" DROP CONSTRAINT "sync_cursors_entity_type_check";--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "review_comments_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pr_review_comments" ADD CONSTRAINT "pr_review_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_comments" ADD CONSTRAINT "pr_review_comments_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_comments" ADD CONSTRAINT "pr_review_comments_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_comments" ADD CONSTRAINT "pr_review_comments_author_identity_id_identities_id_fk" FOREIGN KEY ("author_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pr_review_comments_workspace_repo_created_idx" ON "pr_review_comments" USING btree ("workspace_id","repo_id","created_at");--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_entity_type_check" CHECK ("sync_cursors"."entity_type" in ('commits', 'prs', 'reviews', 'pr_files', 'checks', 'issues', 'releases', 'deployments', 'workflow_runs', 'commit_files', 'review_comments'));