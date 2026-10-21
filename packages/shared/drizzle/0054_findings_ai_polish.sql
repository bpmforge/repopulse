-- W20-21 (UX_TODO FND-25, FND-51, AI-29, AI-63). All additive and nullable.
--
-- findings.review_by: the date an accepted risk is looked at again. A
-- dismissal as accepted risk never came back for review; the nightly reconcile
-- now reopens one whose date has passed, with a history row saying why.
--
-- findings.last_seen_scan_run_id and finding_events.scan_run_id: which scan
-- last saw a finding, and which scan stopped seeing it. The history said only
-- "resolved (automatic: outdated_diff)", with no scan, commit or date behind it.
--
-- egress_audit.role and ai_pass_run_id: what the call was for and which AI pass
-- made it. Plain columns, no foreign key: the audit is append-only (SC-15) and
-- must not depend on a pass row that may later be removed.
--
-- llm_providers.last_success_at / last_error_at / last_error: written from real
-- gateway calls, so Models and System health say whether a model is answering.
ALTER TABLE "findings" ADD COLUMN "review_by" date;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "last_seen_scan_run_id" bigint;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_seen_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("last_seen_scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD COLUMN "scan_run_id" bigint;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_events_scan_run_id_idx" ON "finding_events" USING btree ("scan_run_id") WHERE "scan_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "ai_pass_run_id" bigint;--> statement-breakpoint
CREATE INDEX "egress_audit_workspace_sent_at_idx" ON "egress_audit" USING btree ("workspace_id","sent_at");--> statement-breakpoint
ALTER TABLE "llm_providers" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD COLUMN "last_error" text;
