-- Synthetic diagnostics only. Apply after the two development ledger schemas.
CREATE TABLE IF NOT EXISTS dev_isolated_preflight_audit (
 decision_id TEXT PRIMARY KEY NOT NULL,
 venue TEXT NOT NULL, account_id TEXT NOT NULL,
 futures_revision INTEGER NOT NULL CHECK(futures_revision>=0),
 collateral_revision INTEGER NOT NULL CHECK(collateral_revision>=0),
 payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TRIGGER IF NOT EXISTS dev_isolated_preflight_no_update BEFORE UPDATE ON dev_isolated_preflight_audit
BEGIN SELECT RAISE(ABORT,'Preflight audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_isolated_preflight_no_delete BEFORE DELETE ON dev_isolated_preflight_audit
BEGIN SELECT RAISE(ABORT,'Preflight audit is append-only'); END;
