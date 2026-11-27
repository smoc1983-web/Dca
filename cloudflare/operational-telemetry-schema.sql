-- Isolated development telemetry. Independent of the live alerts table.
CREATE TABLE IF NOT EXISTS dev_source_samples (
 sample_id TEXT PRIMARY KEY NOT NULL,
 source TEXT NOT NULL,
 operation TEXT NOT NULL,
 observed_at INTEGER NOT NULL CHECK(observed_at>=0),
 duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
 outcome TEXT NOT NULL,
 http_status INTEGER CHECK(http_status BETWEEN 100 AND 599)
);
CREATE INDEX IF NOT EXISTS dev_source_samples_by_time ON dev_source_samples(observed_at);

CREATE TABLE IF NOT EXISTS dev_delivery_audit (
 signal_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),
 event_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','delivered','uncertain')),
 changed_at INTEGER NOT NULL CHECK(changed_at>=0),
 retry_at INTEGER CHECK(retry_at>=changed_at),
 evidence TEXT,
 PRIMARY KEY(signal_id,revision)
);
CREATE TRIGGER IF NOT EXISTS dev_delivery_no_update BEFORE UPDATE ON dev_delivery_audit
BEGIN SELECT RAISE(ABORT,'Delivery audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_delivery_no_delete BEFORE DELETE ON dev_delivery_audit
BEGIN SELECT RAISE(ABORT,'Delivery audit is append-only'); END;

CREATE TABLE IF NOT EXISTS dev_health_notices (
 revision INTEGER PRIMARY KEY CHECK(revision>=1),
 kind TEXT NOT NULL CHECK(kind IN ('incident','recovered')),
 health_status TEXT NOT NULL CHECK(health_status IN ('healthy','degraded','unavailable')),
 recorded_at INTEGER NOT NULL CHECK(recorded_at>=0)
);
CREATE TRIGGER IF NOT EXISTS dev_health_notices_no_update BEFORE UPDATE ON dev_health_notices
BEGIN SELECT RAISE(ABORT,'Health notice audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS dev_health_notices_no_delete BEFORE DELETE ON dev_health_notices
BEGIN SELECT RAISE(ABORT,'Health notice audit is append-only'); END;
