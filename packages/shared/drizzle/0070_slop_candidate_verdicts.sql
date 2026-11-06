-- W27-02 (2026-11-06): anti-slop verdict memory.
--
-- One row per fast-lane candidate the model already judged, keyed by a hash of
-- the checklist version, rule, file path and whitespace-collapsed excerpt. The
-- next scan sends the model only candidates with no row: unchanged ones are not
-- judged again on every commit; a changed excerpt is a new hash.
--
-- No source text is stored here (C1a): hashes, rule ids and paths only.
--
-- TENANCY. workspace_id NOT NULL, leading the unique index (Law 5).
--
-- ROLLBACK. DROP TABLE "slop_candidate_verdicts"; the next scan judges every
-- candidate once more and fills it again.
CREATE TABLE "slop_candidate_verdicts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "slop_candidate_verdicts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"candidate_hash" text NOT NULL,
	"rule_id" text NOT NULL,
	"file" text NOT NULL,
	"outcome" text NOT NULL,
	"scan_run_id" bigint,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slop_candidate_verdicts_key" UNIQUE("workspace_id","repo_id","candidate_hash"),
	CONSTRAINT "slop_candidate_verdicts_outcome_check" CHECK ("slop_candidate_verdicts"."outcome" in ('confirmed', 'silent'))
);
--> statement-breakpoint
ALTER TABLE "slop_candidate_verdicts" ADD CONSTRAINT "slop_candidate_verdicts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slop_candidate_verdicts" ADD CONSTRAINT "slop_candidate_verdicts_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;
