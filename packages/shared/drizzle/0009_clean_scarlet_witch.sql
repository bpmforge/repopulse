CREATE TABLE "agreements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agreements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_ids" bigint[] NOT NULL,
	"kind" text NOT NULL,
	"threshold" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agreements_kind_check" CHECK ("agreements"."kind" in ('pr_size_max', 'review_within_hours', 'no_unreviewed_merge', 'stale_ceiling', 'ci_pass_floor'))
);
--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreements_workspace_id_idx" ON "agreements" USING btree ("workspace_id");