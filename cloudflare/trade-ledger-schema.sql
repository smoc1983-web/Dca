-- Isolated development ledger. Do not apply to production without migration review.
CREATE TABLE IF NOT EXISTS trade_ledger_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TRIGGER IF NOT EXISTS trade_ledger_no_update
BEFORE UPDATE ON trade_ledger_audit BEGIN
  SELECT RAISE(ABORT, 'Ledger is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trade_ledger_no_delete
BEFORE DELETE ON trade_ledger_audit BEGIN
  SELECT RAISE(ABORT, 'Ledger is append-only');
END;
