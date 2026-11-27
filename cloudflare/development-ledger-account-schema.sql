-- Apply only to a purpose-built synthetic account's D1.
CREATE TABLE IF NOT EXISTS dev_ledger_account (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 64)
);
CREATE TRIGGER IF NOT EXISTS dev_ledger_account_initial_assignment
BEFORE INSERT ON dev_ledger_account BEGIN
 SELECT RAISE(ABORT,'Ledger account is immutable') WHERE EXISTS(SELECT 1 FROM dev_ledger_account);
 SELECT RAISE(ABORT,'Cannot assign existing ledger history') WHERE EXISTS(SELECT 1 FROM trade_ledger_audit);
END;
CREATE TRIGGER IF NOT EXISTS dev_ledger_account_no_update BEFORE UPDATE ON dev_ledger_account
BEGIN SELECT RAISE(ABORT,'Ledger account is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dev_ledger_account_no_delete BEFORE DELETE ON dev_ledger_account
BEGIN SELECT RAISE(ABORT,'Ledger account is immutable'); END;
