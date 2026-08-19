CREATE TABLE "sboms" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sboms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"commit_sha" text NOT NULL,
	"format" text DEFAULT 'cyclonedx' NOT NULL,
	"document" jsonb NOT NULL,
	"component_count" bigint DEFAULT 0 NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sboms_workspace_repo_sha_key" UNIQUE("workspace_id","repo_id","commit_sha")
);
--> statement-breakpoint
ALTER TABLE "findings" DROP CONSTRAINT "findings_dimension_check";--> statement-breakpoint
ALTER TABLE "findings" ALTER COLUMN "file" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ALTER COLUMN "line_start" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ALTER COLUMN "line_end" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "scanner_key" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "rule_id" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "cve_id" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "chain_id" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "preconditions" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "yields" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "scan_run_id" bigint;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sboms_workspace_repo_idx" ON "sboms" USING btree ("workspace_id","repo_id");--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_dimension_check" CHECK ("findings"."dimension" in ('code_health', 'security', 'performance', 'test_coverage', 'secrets', 'dependency', 'sast', 'iac', 'chain'));