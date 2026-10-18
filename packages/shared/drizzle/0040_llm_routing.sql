CREATE TABLE "llm_role_routes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_role_routes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"role" text NOT NULL,
	"position" integer NOT NULL,
	"provider_id" bigint NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_role_routes_workspace_role_position_key" UNIQUE("workspace_id","role","position"),
	CONSTRAINT "llm_role_routes_role_check" CHECK (role in ('security', 'performance', 'code_health', 'best_practices', 'ai_slop', 'test_coverage', 'triage', 'patch')),
	CONSTRAINT "llm_role_routes_position_check" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "llm_routing_policy" (
	"workspace_id" bigint PRIMARY KEY NOT NULL,
	"local_only" boolean DEFAULT false NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_role_routes" ADD CONSTRAINT "llm_role_routes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_role_routes" ADD CONSTRAINT "llm_role_routes_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_routing_policy" ADD CONSTRAINT "llm_routing_policy_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_routing_policy" ADD CONSTRAINT "llm_routing_policy_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_role_routes_workspace_id_idx" ON "llm_role_routes" USING btree ("workspace_id");
