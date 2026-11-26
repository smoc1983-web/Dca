-- Offline cash audit; no real balances or deployment.
CREATE TABLE IF NOT EXISTS dev_cash_audit (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 op_id TEXT NOT NULL UNIQUE,
 payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TRIGGER IF NOT EXISTS dev_cash_no_update BEFORE UPDATE ON dev_cash_audit
BEGIN SELECT RAISE(ABORT,'Cash audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_cash_no_delete BEFORE DELETE ON dev_cash_audit
BEGIN SELECT RAISE(ABORT,'Cash audit is append-only'); END;
