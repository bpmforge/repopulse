-- W20-10 (UX_TODO X-04): audit events were written only to the container log.
-- This is the persisted, workspace-scoped copy behind Settings → Audit log.
-- actor_user_id is deliberately not a foreign key: removing a member deletes
-- their user row, and the audit entry is where their name has to survive.
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"event" text NOT NULL,
	"actor_user_id" bigint,
	"actor_login" text,
	"ip" text,
	"ua" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workspace_occurred_idx" ON "audit_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_event_idx" ON "audit_events" USING btree ("workspace_id","event");
