CREATE TABLE "rule_registry" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rule_registry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"rule_id" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"provenance" jsonb NOT NULL,
	"shadow_started_at" timestamp with time zone,
	"fp_rate" text,
	"demotion_candidate" boolean DEFAULT false NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_registry_workspace_rule_key" UNIQUE("workspace_id","rule_id"),
	CONSTRAINT "rule_registry_status_check" CHECK ("rule_registry"."status" in ('proposed', 'candidate', 'active', 'deprecated'))
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "experimental" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_registry" ADD CONSTRAINT "rule_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_registry" ADD CONSTRAINT "rule_registry_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rule_registry_workspace_status_idx" ON "rule_registry" USING btree ("workspace_id","status");