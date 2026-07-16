-- Migration 0002 (W1-02): SC-15 egress_audit append-only enforcement.
-- Rollback note (PLAYBOOK §Migration tickets):
--   REVOKE SELECT, INSERT ON egress_audit FROM repopulse_app;
--   REVOKE USAGE ON SCHEMA public FROM repopulse_app;
--   DROP ROLE IF EXISTS repopulse_app;
--   Safe as long as nothing else has been granted to/depends on the role
--   yet (true as of this migration — SC-15 scopes this ticket to
--   egress_audit only; broader app-role grants for other tables land at
--   deploy-wave hardening per SC-20, and runtime wiring — the app actually
--   connecting as this role — lands W2 per SC-15's own "Lands" note).
--
-- NOLOGIN: this migration only proves the DB-level constraint (SC-15
-- acceptance: UPDATE/DELETE fail as this role); W2 adds real credentials
-- and runtime connection wiring.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'repopulse_app') THEN
    CREATE ROLE repopulse_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO repopulse_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON egress_audit TO repopulse_app;
--> statement-breakpoint

-- Explicit, not implicit: UPDATE/DELETE are never granted (SC-15 —
-- append-only enforced at the DB layer, not just application discipline).
REVOKE UPDATE, DELETE ON egress_audit FROM repopulse_app;
