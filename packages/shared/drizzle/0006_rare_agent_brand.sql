-- Migration 0006 (W4-10): users.persona + users.prefs.
-- Rollback note (PLAYBOOK §Migration tickets — Drizzle has no auto-down):
--   ALTER TABLE "users" DROP COLUMN "prefs";
--   ALTER TABLE "users" DROP COLUMN "persona";
--   Both are additive and nullable-or-defaulted, so the forward migration is
--   safe on a populated table and the rollback loses only the persona choice
--   and the onboarding-checklist dismissal — neither is derived from anything
--   else and both are re-answerable by the user. No backfill: a NULL persona
--   is meaningful (it is what triggers the picker), so defaulting existing
--   rows to any value would silently answer a question nobody was asked.
--   `users` is tenancy-exempt by design (DATABASE.md §2 — a user may join
--   many workspaces), and neither column changes that.
ALTER TABLE "users" ADD COLUMN "persona" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;
