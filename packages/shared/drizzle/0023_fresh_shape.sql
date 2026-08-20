ALTER TABLE "users" ALTER COLUMN "forge_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_subject" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- BACKFILL BEFORE THE CONSTRAINT (W15-01, hand-edited).
--
-- drizzle-kit generated the ADD CONSTRAINT immediately after the ADD COLUMN,
-- which cannot work: every existing row takes the '' default, so the unique
-- index over (auth_provider, auth_subject) collides on the second user. This
-- database had four. Every existing account was created by GitHub OAuth, so
-- its forge id IS its subject — that is what makes the backfill exact rather
-- than a guess, and it is why nobody is logged out by this migration.
UPDATE "users" SET "auth_subject" = "forge_user_id" WHERE "auth_subject" = '' AND "forge_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_provider_subject_key" UNIQUE("auth_provider","auth_subject");
