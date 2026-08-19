CREATE TABLE "file_intents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "file_intents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"path" text NOT NULL,
	"intent" text NOT NULL,
	"note" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"warn_after_months" smallint DEFAULT 3 NOT NULL,
	CONSTRAINT "file_intents_workspace_repo_path_key" UNIQUE("workspace_id","repo_id","path"),
	CONSTRAINT "file_intents_intent_check" CHECK ("file_intents"."intent" in ('refactor', 'supervise', 'acknowledged'))
);
--> statement-breakpoint
ALTER TABLE "file_intents" ADD CONSTRAINT "file_intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_intents" ADD CONSTRAINT "file_intents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_intents_workspace_repo_idx" ON "file_intents" USING btree ("workspace_id","repo_id");