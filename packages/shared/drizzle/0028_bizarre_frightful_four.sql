-- Migration 0028 (W17-11): audit every outbound model request, not just Tier-3.
--
-- WHY. egress_audit could record a Tier-3 SUCCESS and nothing else. It could not
-- express an attempt that failed or timed out (the bytes still left the
-- network), it could not record unknown token usage without claiming zero, and
-- it had no writer in production at all — createT3Client was called only from
-- its own test. Meanwhile a Tier-2 provider row may name a PUBLIC host, so
-- diffs were leaving the network on a path this table never saw.
--
-- ALL ADDITIVE. Three columns are widened from NOT NULL to nullable and five
-- are added; no column is dropped, no data is rewritten, and every existing row
-- stays valid and readable.
--
-- Rollback note (PLAYBOOK §Migration tickets):
--   ALTER TABLE egress_audit DROP COLUMN IF EXISTS attempt_id;
--   ALTER TABLE egress_audit DROP COLUMN IF EXISTS outcome;
--   ALTER TABLE egress_audit DROP COLUMN IF EXISTS destination_host;
--   ALTER TABLE egress_audit DROP COLUMN IF EXISTS tier;
--   ALTER TABLE egress_audit DROP COLUMN IF EXISTS error;
--   DROP INDEX IF EXISTS egress_audit_attempt_id_idx;
--   -- Re-adding NOT NULL is only safe if no row written since this migration
--   -- has a NULL there. Rows recorded with unknown usage legitimately do, so
--   -- the widening is NOT reversible without deciding what those rows meant.
--   -- Do not re-add NOT NULL without that decision.
--
-- Tenancy: workspace_id is unchanged and still NOT NULL with its index.
-- SC-15: the INSERT-only grant from 0002 is untouched, which is why an outcome
-- is an appended row rather than an UPDATE.

ALTER TABLE "egress_audit" ALTER COLUMN "analysis_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_audit" ALTER COLUMN "tokens_sent" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_audit" ALTER COLUMN "tokens_received" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "attempt_id" text;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "destination_host" text;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "tier" smallint;--> statement-breakpoint
ALTER TABLE "egress_audit" ADD COLUMN "error" text;--> statement-breakpoint
CREATE INDEX "egress_audit_attempt_id_idx" ON "egress_audit" USING btree ("attempt_id");