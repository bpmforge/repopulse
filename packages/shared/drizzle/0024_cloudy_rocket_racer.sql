CREATE TABLE "vex_statements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vex_statements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"package_purl" text NOT NULL,
	"vuln_id" text NOT NULL,
	"version_range" text NOT NULL,
	"status" text NOT NULL,
	"justification" text,
	"status_notes" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"author_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vex_statements_identity_key" UNIQUE("workspace_id","repo_id","package_purl","vuln_id","version_range"),
	CONSTRAINT "vex_statements_status_check" CHECK ("vex_statements"."status" in ('not_affected', 'affected', 'fixed')),
	CONSTRAINT "vex_statements_justification_enum_check" CHECK ("vex_statements"."justification" is null or "vex_statements"."justification" in ('component_not_present', 'vulnerable_code_not_present', 'vulnerable_code_not_in_execute_path', 'vulnerable_code_cannot_be_controlled_by_adversary', 'inline_mitigations_already_exist')),
	CONSTRAINT "vex_statements_justification_required_check" CHECK ("vex_statements"."status" <> 'not_affected' or "vex_statements"."justification" is not null)
);
--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "validation_funnel" jsonb;--> statement-breakpoint
ALTER TABLE "vex_statements" ADD CONSTRAINT "vex_statements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vex_statements" ADD CONSTRAINT "vex_statements_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vex_statements_workspace_repo_idx" ON "vex_statements" USING btree ("workspace_id","repo_id");--> statement-breakpoint
CREATE INDEX "vex_statements_lookup_idx" ON "vex_statements" USING btree ("workspace_id","repo_id","vuln_id");