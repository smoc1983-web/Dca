-- Isolated test schema; apply after trade-ledger-schema.sql.
CREATE TABLE IF NOT EXISTS dev_budget_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  request TEXT NOT NULL CHECK(json_valid(request)),
  state TEXT NOT NULL CHECK(json_valid(state)),
  ledger_op TEXT CHECK(ledger_op IS NULL OR json_valid(ledger_op))
);
CREATE TRIGGER IF NOT EXISTS dev_budget_append_fill AFTER INSERT ON dev_budget_audit
WHEN NEW.ledger_op IS NOT NULL BEGIN
  INSERT INTO trade_ledger_audit(op_id,payload) VALUES(json_extract(NEW.ledger_op,'$.opId'),NEW.ledger_op);
END;
CREATE TRIGGER IF NOT EXISTS dev_budget_no_update BEFORE UPDATE ON dev_budget_audit
BEGIN SELECT RAISE(ABORT,'Budget audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_budget_no_delete BEFORE DELETE ON dev_budget_audit
BEGIN SELECT RAISE(ABORT,'Budget audit is append-only'); END;
