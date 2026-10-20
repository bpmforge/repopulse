-- W20-17: identities.provider allowed only github and gitea, so a GitLab
-- committer could never be stored as a GitLab identity. Ingest also never told
-- the identity resolver which forge it was reading, so every Gitea and GitLab
-- committer was stored as 'github'. Widen the check to match
-- forge_connections, then relabel the identities of a workspace whose
-- connections all use one non-GitHub forge (the only case where the true
-- forge is known for certain). Mixed-forge workspaces keep their labels.
ALTER TABLE "identities" DROP CONSTRAINT "identities_provider_check";--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_provider_check" CHECK ("identities"."provider" in ('github', 'gitea', 'gitlab'));--> statement-breakpoint
UPDATE "identities" AS i
SET "provider" = only_forge.provider
FROM (
	SELECT "workspace_id", min("provider") AS provider
	FROM "forge_connections"
	GROUP BY "workspace_id"
	HAVING count(DISTINCT "provider") = 1 AND min("provider") <> 'github'
) AS only_forge
WHERE i."workspace_id" = only_forge."workspace_id"
	AND i."provider" = 'github'
	AND NOT EXISTS (
		SELECT 1 FROM "identities" AS dup
		WHERE dup."workspace_id" = i."workspace_id"
			AND dup."provider" = only_forge.provider
			AND dup."forge_login" = i."forge_login"
	);
