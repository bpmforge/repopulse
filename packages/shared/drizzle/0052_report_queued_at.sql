-- W20-19 (UX_TODO ADM-61): a Retry used to overwrite reports.generated_at, so
-- last month's report, retried today, sorted and read as today's in History
-- while its cover still said last month. generated_at is now set once, when
-- the report is first asked for, and queued_at records when the row was last
-- queued (equal to generated_at until a retry). Existing rows start with the
-- two equal: their original date was already lost to any earlier retry.
ALTER TABLE "reports" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
UPDATE "reports" SET "queued_at" = "generated_at";--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "queued_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "queued_at" SET NOT NULL;
