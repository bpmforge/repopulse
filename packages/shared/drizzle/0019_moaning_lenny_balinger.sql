ALTER TABLE "findings" ADD COLUMN "effective_risk" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "risk_factors" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "risk_band" text;--> statement-breakpoint
CREATE INDEX "findings_workspace_repo_risk_idx" ON "findings" USING btree ("workspace_id","repo_id","status","effective_risk" DESC NULLS LAST);