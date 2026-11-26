-- Test-only append-only isolated collateral audit, scoped by venue/account.
CREATE TABLE IF NOT EXISTS dev_collateral_audit (
 venue TEXT NOT NULL, account_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=0),
 op_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 PRIMARY KEY(venue,account_id,revision), UNIQUE(venue,account_id,op_id)
);
CREATE TRIGGER IF NOT EXISTS dev_collateral_no_update BEFORE UPDATE ON dev_collateral_audit
BEGIN SELECT RAISE(ABORT,'Collateral audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_collateral_no_delete BEFORE DELETE ON dev_collateral_audit
BEGIN SELECT RAISE(ABORT,'Collateral audit is append-only'); END;
