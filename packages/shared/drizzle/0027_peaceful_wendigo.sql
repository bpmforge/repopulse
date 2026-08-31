ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "forge_connections" DROP CONSTRAINT "forge_connections_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "identities" DROP CONSTRAINT "identities_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_providers" DROP CONSTRAINT "llm_providers_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "findings" DROP CONSTRAINT "findings_status_changed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "finding_events" DROP CONSTRAINT "finding_events_actor_users_id_fk";
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_generated_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "saved_views" DROP CONSTRAINT "saved_views_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "egress_audit" DROP CONSTRAINT "egress_audit_initiator_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agreements" DROP CONSTRAINT "agreements_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "file_intents" DROP CONSTRAINT "file_intents_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "improvement_plans" DROP CONSTRAINT "improvement_plans_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "plan_item_events" DROP CONSTRAINT "plan_item_events_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "plan_items" DROP CONSTRAINT "plan_items_status_changed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "repo_scanner_config" DROP CONSTRAINT "repo_scanner_config_updated_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "rule_registry" DROP CONSTRAINT "rule_registry_updated_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "vex_statements" DROP CONSTRAINT "vex_statements_author_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "forge_connections" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_providers" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "generated_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_audit" ALTER COLUMN "initiator_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agreements" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "file_intents" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "improvement_plans" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_events" ADD COLUMN "actor_login" text;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "initiator_login" text;--> statement-breakpoint
ALTER TABLE "plan_item_events" ADD COLUMN "actor_login" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_connections" ADD CONSTRAINT "forge_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_actor_users_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD CONSTRAINT "egress_audit_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_intents" ADD CONSTRAINT "file_intents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_plans" ADD CONSTRAINT "improvement_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_item_events" ADD CONSTRAINT "plan_item_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_scanner_config" ADD CONSTRAINT "repo_scanner_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_registry" ADD CONSTRAINT "rule_registry_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vex_statements" ADD CONSTRAINT "vex_statements_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;