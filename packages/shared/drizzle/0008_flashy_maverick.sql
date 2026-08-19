CREATE TABLE "improvement_plans" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "improvement_plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_ids" bigint[] NOT NULL,
	"window" text NOT NULL,
	"created_from_report_id" bigint,
	"catalog_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "improvement_plans_status_check" CHECK ("improvement_plans"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "plan_item_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plan_item_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"plan_item_id" bigint NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" bigint,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plan_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"plan_id" bigint NOT NULL,
	"rank" integer NOT NULL,
	"catalog_id" text NOT NULL,
	"source" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"recommendation" text NOT NULL,
	"effort" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"verify_criterion" jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"status_changed_by" bigint,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_items_source_check" CHECK ("plan_items"."source" in ('metric', 'finding', 'chain', 'compound', 'agreement')),
	CONSTRAINT "plan_items_effort_check" CHECK ("plan_items"."effort" in ('S', 'M', 'L')),
	CONSTRAINT "plan_items_status_check" CHECK ("plan_items"."status" in ('proposed', 'accepted', 'in_progress', 'done', 'regressed', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "improvement_plans" ADD CONSTRAINT "improvement_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_plans" ADD CONSTRAINT "improvement_plans_created_from_report_id_reports_id_fk" FOREIGN KEY ("created_from_report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_plans" ADD CONSTRAINT "improvement_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_item_events" ADD CONSTRAINT "plan_item_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_item_events" ADD CONSTRAINT "plan_item_events_plan_item_id_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."plan_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_item_events" ADD CONSTRAINT "plan_item_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_id_improvement_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."improvement_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "improvement_plans_workspace_id_idx" ON "improvement_plans" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "plan_item_events_workspace_item_idx" ON "plan_item_events" USING btree ("workspace_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "plan_items_workspace_plan_status_rank_idx" ON "plan_items" USING btree ("workspace_id","plan_id","status","rank");