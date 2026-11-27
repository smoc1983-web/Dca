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

-- Only a fresh synthetic futures journal can be assigned to an account.
CREATE TABLE IF NOT EXISTS dev_futures_account (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 venue TEXT NOT NULL, account_id TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS dev_futures_account_requires_empty
BEFORE INSERT ON dev_futures_account WHEN EXISTS(SELECT 1 FROM dev_futures_audit)
BEGIN SELECT RAISE(ABORT,'Cannot bind existing futures history'); END;
CREATE TRIGGER IF NOT EXISTS dev_futures_account_no_update BEFORE UPDATE ON dev_futures_account
BEGIN SELECT RAISE(ABORT,'Futures account binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dev_futures_account_no_delete BEFORE DELETE ON dev_futures_account
BEGIN SELECT RAISE(ABORT,'Futures account binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dev_futures_audit_account_guard BEFORE INSERT ON dev_futures_audit
WHEN EXISTS (SELECT 1 FROM dev_futures_account)
 AND NOT EXISTS (
  SELECT 1 FROM dev_futures_account
  WHERE venue=json_extract(NEW.payload,'$.account.venue')
    AND account_id=json_extract(NEW.payload,'$.account.accountId')
    AND json_extract(NEW.payload,'$.account.mode')='isolated'
    AND json_type(NEW.payload,'$.account.synthetic')='true'
 )
BEGIN SELECT RAISE(ABORT,'Futures operation account mismatch'); END;
