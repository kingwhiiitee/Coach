-- rule_baseline：最近一步做错后又有做对的随堂检查 / 自己解释 → assisted（不再一直是 weak）；
-- independent 满 30 天、validated 满 60 天没有新证据 → recheck。
-- 只重建视图，列不变，新旧 Worker 都能用，和部署的先后顺序无关：
-- npx wrangler d1 execute learning-knowledge --remote --file migrations/0005-baseline-repair-and-recheck.sql
DROP VIEW IF EXISTS rule_baseline;
CREATE VIEW rule_baseline AS
WITH steps AS (
  SELECT e.id, e.node_id, e.outcome, e.observed_at, a.hints, a.context,
         ROW_NUMBER() OVER (PARTITION BY e.node_id ORDER BY e.observed_at DESC, e.id DESC) AS rn
  FROM evidence e JOIN attempts a ON a.id = e.attempt_id
  WHERE e.kind = 'step' AND e.outcome IN ('demonstrated','failed')
    AND NOT (e.outcome = 'demonstrated' AND COALESCE(e.qualifier,'') IN ('guessed','lucky_path'))
    AND NOT (e.outcome = 'failed' AND COALESCE(e.qualifier,'') = 'slip')
),
seen AS (SELECT node_id, MAX(observed_at) AS last_seen FROM evidence GROUP BY node_id)
SELECT n.id AS node_id, seen.last_seen,
  CASE
    WHEN seen.last_seen IS NULL THEN 'unknown'
    WHEN NOT EXISTS (SELECT 1 FROM steps WHERE steps.node_id = n.id) THEN 'exposed'
    WHEN EXISTS (SELECT 1 FROM steps WHERE steps.node_id = n.id AND rn = 1 AND outcome = 'failed') THEN
      CASE WHEN EXISTS (SELECT 1 FROM evidence c JOIN steps f ON f.node_id = c.node_id AND f.rn = 1
                        WHERE c.node_id = n.id AND c.id > f.id AND c.kind IN ('prediction','self_explain')
                          AND c.outcome = 'demonstrated' AND COALESCE(c.qualifier,'') NOT IN ('guessed','lucky_path'))
           THEN 'assisted' ELSE 'weak' END
    WHEN (SELECT COUNT(DISTINCT date(observed_at)) FROM steps
          WHERE steps.node_id = n.id AND outcome = 'demonstrated' AND hints = 'none'
            AND context IN ('delayed','mixed','unseen_variant')) >= 2 THEN
      CASE WHEN julianday('now') - julianday(seen.last_seen) >= 60 THEN 'recheck' ELSE 'validated' END
    WHEN EXISTS (SELECT 1 FROM steps WHERE steps.node_id = n.id AND outcome = 'demonstrated' AND hints = 'none'
                   AND context <> 'right_after_teaching') THEN
      CASE WHEN julianday('now') - julianday(seen.last_seen) >= 30 THEN 'recheck' ELSE 'independent' END
    ELSE 'assisted'
  END AS suggested_level
FROM nodes n LEFT JOIN seen ON seen.node_id = n.id;
