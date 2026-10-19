-- W19-12: scheduled AI passes. A repository's schedule is OFF until an admin
-- turns it on, and turning it on stores who acknowledged that code will be sent
-- to the configured models with nobody pressing start. A schedule only starts
-- ordinary passes, marked trigger 'schedule'; existing passes were all manual.
CREATE TABLE "ai_pass_schedules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_pass_schedules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" text DEFAULT 'new_commits' NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cadence" text DEFAULT 'weekly' NOT NULL,
	"monthly_cap" integer DEFAULT 4 NOT NULL,
	"require_local" boolean DEFAULT true NOT NULL,
	"acknowledged_by" bigint,
	"acknowledged_at" timestamp with time zone,
	"ack_version" text,
	"last_head_sha" text,
	"last_scheduled_at" timestamp with time zone,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_pass_schedules_scope_check" CHECK ("ai_pass_schedules"."scope" in ('paths', 'new_commits')),
	CONSTRAINT "ai_pass_schedules_cadence_check" CHECK ("ai_pass_schedules"."cadence" in ('daily', 'weekly')),
	CONSTRAINT "ai_pass_schedules_cap_check" CHECK ("ai_pass_schedules"."monthly_cap" between 1 and 31),
	CONSTRAINT "ai_pass_schedules_ack_check" CHECK (not "ai_pass_schedules"."enabled" or ("ai_pass_schedules"."acknowledged_at" is not null and "ai_pass_schedules"."ack_version" is not null))
);
--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pass_schedules_workspace_repo_key" ON "ai_pass_schedules" USING btree ("workspace_id","repo_id");--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "schedule_id" bigint;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_schedule_id_ai_pass_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."ai_pass_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_trigger_check" CHECK ("ai_pass_runs"."trigger" in ('manual', 'schedule'));
