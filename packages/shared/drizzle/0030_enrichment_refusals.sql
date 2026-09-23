-- Migration 0030 (W17-38, residual R-15): let enrichment record a refusal.
--
-- WHY. The enrichment fetches (reviews, check runs, commit files) read an HTTP
-- error as "nothing here": a 403 on check runs stamped the PR enriched with
-- zero CI, a 404 on a commit wrote zero churn as if measured. A permanent
-- refusal is now recorded on sync_cursors (a new 'commit_files' entity type;
-- 'reviews' and 'checks' were already allowed) and a refused commit is stamped
-- stats_source='unavailable' so it leaves the enrichment work-list without
-- pretending to be measured.
--
-- TENANCY. No new table or column; both tables already carry workspace_id.
--
-- ROLLBACK. Restore the two previous CHECKs after clearing the new values:
--   UPDATE "commits" SET "stats_source" = NULL WHERE "stats_source" = 'unavailable';
--   DELETE FROM "sync_cursors" WHERE "entity_type" = 'commit_files';
--   then re-add the CHECKs without 'unavailable' / 'commit_files' (0029 snapshot).
ALTER TABLE "sync_cursors" DROP CONSTRAINT "sync_cursors_entity_type_check";--> statement-breakpoint
ALTER TABLE "commits" DROP CONSTRAINT "commits_stats_source_check";--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_entity_type_check" CHECK ("sync_cursors"."entity_type" in ('commits', 'prs', 'reviews', 'pr_files', 'checks', 'issues', 'releases', 'deployments', 'workflow_runs', 'commit_files'));--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_stats_source_check" CHECK ("commits"."stats_source" is null or "commits"."stats_source" in ('detail', 'stats_api', 'graphql', 'unavailable'));