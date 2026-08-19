CREATE TABLE "repo_scanner_config" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repo_scanner_config_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"scanner_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_scanner_config_workspace_repo_scanner_key" UNIQUE("workspace_id","repo_id","scanner_key")
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scan_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"scanner_key" text NOT NULL,
	"scanner_version" text NOT NULL,
	"commit_sha" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"finding_count" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scan_runs_status_check" CHECK ("scan_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'budget_exceeded')),
	CONSTRAINT "scan_runs_trigger_check" CHECK ("scan_runs"."trigger" in ('pr_synced', 'push', 'schedule', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "repo_scanner_config" ADD CONSTRAINT "repo_scanner_config_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_scanner_config" ADD CONSTRAINT "repo_scanner_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_scanner_config_workspace_repo_idx" ON "repo_scanner_config" USING btree ("workspace_id","repo_id");--> statement-breakpoint
CREATE INDEX "scan_runs_workspace_repo_idx" ON "scan_runs" USING btree ("workspace_id","repo_id");