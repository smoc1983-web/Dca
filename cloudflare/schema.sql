CREATE TABLE IF NOT EXISTS control (
  id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('shadow','live')), epoch TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  key TEXT PRIMARY KEY, model TEXT NOT NULL, next_close INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, closed INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
  next_try INTEGER NOT NULL DEFAULT 0, receipt INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_ready ON alerts(status,next_try,closed);
CREATE TABLE IF NOT EXISTS runs (
  minute INTEGER PRIMARY KEY, checked INTEGER, failures INTEGER, market_time INTEGER
);
