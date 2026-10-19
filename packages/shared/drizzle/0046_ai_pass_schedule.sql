-- W19-12: scheduled AI passes, strictly opt-in. A schedule is OFF until an admin
-- enables it for a repository AND acknowledges what leaves the network (the
-- acknowledged destinations are stored as a digest, so a later routing change
-- stops the schedule until it is acknowledged again). The monthly model-call cap
-- is per workspace. Passes started by a schedule are marked, and a scheduled run
-- that is refused is recorded as a skipped pass with its reason.
CREATE TABLE "ai_pass_schedules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_pass_schedules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"frequency" text DEFAULT 'weekly' NOT NULL,
	"scope_kind" text DEFAULT 'paths' NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"egress_digest" text,
	"egress_ack" jsonb,
	"enabled_by" bigint,
	"enabled_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_pass_schedules_frequency_check" CHECK ("ai_pass_schedules"."frequency" in ('daily', 'weekly')),
	CONSTRAINT "ai_pass_schedules_scope_check" CHECK ("ai_pass_schedules"."scope_kind" in ('paths', 'new_pull_requests')),
	CONSTRAINT "ai_pass_schedules_enabled_ack_check" CHECK (NOT "ai_pass_schedules"."enabled" OR ("ai_pass_schedules"."egress_digest" IS NOT NULL AND "ai_pass_schedules"."enabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ai_pass_settings" (
	"workspace_id" bigint PRIMARY KEY NOT NULL,
	"monthly_call_cap" integer DEFAULT 300 NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_pass_settings_cap_check" CHECK ("ai_pass_settings"."monthly_call_cap" between 0 and 100000)
);
--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD COLUMN "schedule_id" bigint;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_trigger_check" CHECK ("ai_pass_runs"."trigger" in ('manual', 'scheduled'));--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_schedules" ADD CONSTRAINT "ai_pass_schedules_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_settings" ADD CONSTRAINT "ai_pass_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_settings" ADD CONSTRAINT "ai_pass_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pass_runs" ADD CONSTRAINT "ai_pass_runs_schedule_id_ai_pass_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."ai_pass_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pass_schedules_workspace_repo_key" ON "ai_pass_schedules" USING btree ("workspace_id","repo_id");--> statement-breakpoint
CREATE INDEX "ai_pass_schedules_due_idx" ON "ai_pass_schedules" USING btree ("next_run_at") WHERE enabled;
