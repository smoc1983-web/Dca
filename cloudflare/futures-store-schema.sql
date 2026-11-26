-- Isolated synthetic futures audit; no production migration or connection.
CREATE TABLE IF NOT EXISTS dev_futures_audit (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 op_id TEXT NOT NULL UNIQUE,
 payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TRIGGER IF NOT EXISTS dev_futures_no_update BEFORE UPDATE ON dev_futures_audit
BEGIN SELECT RAISE(ABORT,'Futures audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_futures_no_delete BEFORE DELETE ON dev_futures_audit
BEGIN SELECT RAISE(ABORT,'Futures audit is append-only'); END;
