-- W19-09: the AI pass. Planned specialists and evidence-fed triage over a
-- repository, with the record of each pass, how each specialist finding was
-- raised, and triage SUGGESTIONS that a person accepts or dismisses. Nothing
-- here can change a finding's status (D9a).
CREATE TABLE "ai_pass_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_pass_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"requested_by" bigint,
	"commit_sha" text,
	"paths" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"reason" text,
	"plan" jsonb,
	"specialists" jsonb,
	"triage_funnel" jsonb,
	"triage_skipped" text,
	"calls" integer DEFAULT 0 NOT NULL,
	"analysis_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_pass_runs_status_check" CHECK ("ai_pass_runs"."status" in ('pending', 'running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "ai_finding_provenance" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_finding_provenance_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"finding_id" bigint NOT NULL,
	"ai_pass_run_id" bigint NOT NULL,
	"specialist" text NOT NULL,
	"checklist_version" text NOT NULL,
	"model" text NOT NULL,
	"route" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_triage_verdicts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_triage_verdicts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"finding_id" bigint NOT NULL,
	"ai_pass_run_id" bigint NOT NULL,
	"verdict" text NOT NULL,
	"confidence" smallint NOT NULL,
	"model" text NOT NULL,
	"checklist_version" text NOT NULL,
	"rationale" text NOT NULL,
	"citations" jsonb NOT NULL,
	"vex_justification" text,
	"vex_statement" text,
	"patch_diff" text,
	"patch_status" text DEFAULT 'not_attempted' NOT NULL,
	"patch_reason" text,
	"route" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	CONSTRAINT "ai_triage_verdicts_verdict_check" CHECK ("ai_triage_verdicts"."verdict" in ('real', 'likely_false_positive', 'needs_human')),
	CONSTRAINT "ai_triage_verdicts_confidence_check" CHECK ("ai_triage_verdicts"."confidence" between 1 and 5),
	CONSTRAINT "ai_triage_verdicts_decision_check" CHECK ("ai_triage_verdicts"."decision" is null or "ai_triage_verdicts"."decision" in ('accepted', 'dismissed', 'superseded')),
	CONSTRAINT "ai_triage_verdicts_vex_check" CHECK ("ai_triage_verdicts"."vex_justification" is null or "ai_triage_verdicts"."vex_justification" in ('component_not_present', 'vulnerable_code_not_present', 'vulnerable_code_not_in_execute_path', 'vulnerable_code_cannot_be_controlled_by_adversary', 'inline_mitigations_already_exist')),
	CONSTRAINT "ai_triage_verdicts_decider_check" CHECK ("ai_triage_verdicts"."decision" is null or "ai_triage_verdicts"."decision" = 'superseded' or ("ai_triage_verdicts"."decided_at" is not null)),
	CONSTRAINT "ai_triage_verdicts_patch_check" CHECK ("ai_triage_verdicts"."patch_status" in ('verified', 'rejected', 'failed', 'not_attempted') and ("ai_triage_verdicts"."patch_diff" is null or "ai_triage_verdicts"."patch_status" = 'verified'))
);
--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_finding_provenance" ADD CONSTRAINT "ai_finding_provenance_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_finding_provenance" ADD CONSTRAINT "ai_finding_provenance_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_finding_provenance" ADD CONSTRAINT "ai_finding_provenance_ai_pass_run_id_ai_pass_runs_id_fk" FOREIGN KEY ("ai_pass_run_id") REFERENCES "public"."ai_pass_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_ai_pass_run_id_ai_pass_runs_id_fk" FOREIGN KEY ("ai_pass_run_id") REFERENCES "public"."ai_pass_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_triage_verdicts" ADD CONSTRAINT "ai_triage_verdicts_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_pass_runs_workspace_repo_idx" ON "ai_pass_runs" USING btree ("workspace_id","repo_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pass_runs_one_active_key" ON "ai_pass_runs" USING btree ("workspace_id","repo_id") WHERE status in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "ai_finding_provenance_workspace_finding_idx" ON "ai_finding_provenance" USING btree ("workspace_id","finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_finding_provenance_pass_finding_key" ON "ai_finding_provenance" USING btree ("ai_pass_run_id","finding_id");--> statement-breakpoint
CREATE INDEX "ai_triage_verdicts_workspace_finding_idx" ON "ai_triage_verdicts" USING btree ("workspace_id","finding_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_triage_verdicts_one_open_key" ON "ai_triage_verdicts" USING btree ("finding_id") WHERE decision is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_triage_verdicts_pass_finding_key" ON "ai_triage_verdicts" USING btree ("ai_pass_run_id","finding_id");
