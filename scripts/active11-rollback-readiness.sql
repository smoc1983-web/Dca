-- Run after scheduled executions are paused and in-flight runs have drained.
-- Bind the Astrakhan date (YYYY-MM-DD) of the proposed rollback.
WITH summary(day) AS (SELECT ?1)
SELECT 'undelivered_or_ambiguous' AS blocker, COUNT(*) AS count
FROM alerts
WHERE status IN ('pending', 'sending', 'uncertain', 'test_pending')
HAVING COUNT(*) > 0
UNION ALL
SELECT 'legacy_worker_can_duplicate_daily', COUNT(*)
FROM alerts, summary
WHERE id = 'DAILY:' || day || ':ACTIVE11'
  AND status = 'delivered'
  AND NOT EXISTS (SELECT 1 FROM alerts WHERE id = 'DAILY:' || day)
HAVING COUNT(*) > 0;
