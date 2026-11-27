-- Local D1 fixture only. Observe actual Worker writes in the same transaction.
CREATE TABLE dev_worker_clock (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
CREATE TRIGGER dev_worker_pending AFTER INSERT ON alerts WHEN NEW.status='pending'
BEGIN
 INSERT INTO dev_delivery_audit(signal_id,revision,event_id,kind,status,changed_at)
 SELECT NEW.id,1,NEW.id||':trace:1','enqueue',NEW.status,at FROM dev_worker_clock WHERE id=1;
END;
CREATE TRIGGER dev_worker_transition AFTER UPDATE OF status ON alerts
WHEN OLD.status<>NEW.status AND NEW.status IN ('pending','sending','delivered','uncertain')
BEGIN
 INSERT INTO dev_delivery_audit(signal_id,revision,event_id,kind,status,changed_at,retry_at,evidence)
 SELECT NEW.id,revision,NEW.id||':trace:'||revision,
 CASE NEW.status WHEN 'sending' THEN 'claim' WHEN 'pending' THEN 'rejected'
  WHEN 'uncertain' THEN 'outcome-unknown' ELSE CASE OLD.status WHEN 'uncertain' THEN 'manual-delivered' ELSE 'delivered' END END,
 NEW.status,(SELECT at FROM dev_worker_clock WHERE id=1),
 CASE WHEN NEW.status='pending' THEN NEW.next_try END,
 CASE WHEN NEW.status='pending' THEN 'rejection-confirmed'
  WHEN OLD.status='uncertain' AND NEW.status='delivered' THEN 'delivery-confirmed' END
 FROM (SELECT COALESCE(MAX(revision),0)+1 AS revision FROM dev_delivery_audit WHERE signal_id=NEW.id);
END;
