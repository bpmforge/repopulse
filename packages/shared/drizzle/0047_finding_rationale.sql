-- W20-08 (UX_TODO FND-57): keep a finding's rationale beside its fix.
-- `recommendation` held the fix when there was one and the rationale only when
-- there was not, so a dependency CVE with an upgrade lost the sentence that
-- explains whether the package is reached at all. Nullable: older rows have none.
ALTER TABLE "findings" ADD COLUMN "rationale" text;
