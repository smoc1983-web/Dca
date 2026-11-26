-- Isolated SQLite experiment. Requires trade-ledger-schema.sql first.
-- No connection to existing Worker models or Telegram outbox.
CREATE TABLE IF NOT EXISTS dev_model_registry (
  model_id TEXT PRIMARY KEY,
  config TEXT NOT NULL CHECK(json_valid(config))
);
CREATE TABLE IF NOT EXISTS dev_model_steps (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES dev_model_registry(model_id),
  candle_time INTEGER NOT NULL,
  candle TEXT NOT NULL CHECK(json_valid(candle)),
  state TEXT NOT NULL CHECK(json_valid(state)),
  operation TEXT CHECK(operation IS NULL OR json_valid(operation)),
  event TEXT CHECK(event IS NULL OR json_valid(event)),
  CHECK((operation IS NULL)=(event IS NULL)),
  UNIQUE(model_id,candle_time)
);
CREATE TABLE IF NOT EXISTS dev_model_outbox (
  op_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TRIGGER IF NOT EXISTS dev_model_step_commit
AFTER INSERT ON dev_model_steps WHEN NEW.operation IS NOT NULL BEGIN
  INSERT INTO trade_ledger_audit(op_id,payload)
    VALUES(json_extract(NEW.operation,'$.opId'),NEW.operation);
  INSERT INTO dev_model_outbox(op_id,model_id,payload)
    VALUES(json_extract(NEW.operation,'$.opId'),NEW.model_id,NEW.event);
END;
CREATE TRIGGER IF NOT EXISTS dev_model_step_no_update BEFORE UPDATE ON dev_model_steps
BEGIN SELECT RAISE(ABORT,'Model steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_model_step_no_delete BEFORE DELETE ON dev_model_steps
BEGIN SELECT RAISE(ABORT,'Model steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_model_registry_no_update BEFORE UPDATE ON dev_model_registry
BEGIN SELECT RAISE(ABORT,'Model configuration is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dev_model_registry_no_delete BEFORE DELETE ON dev_model_registry
BEGIN SELECT RAISE(ABORT,'Model configuration is immutable'); END;
