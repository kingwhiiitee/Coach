-- 个人学习知识库 · D1 (SQLite) 表结构 v0.3。只用于建新库；已部署的库靠 migrations/ 升级，改表时两边都要改。
-- 四层（Evidence-Centered Design）：① 知识节点 ② 学习证据 ③ 知识状态 ④ 教学决策。
-- ①不随学生表现变化；②③④ 是学生与知识之间的关系。所有外键都没有 ON DELETE，级联删除由 tools.ts 的 delete_record 负责。
--
PRAGMA foreign_keys = ON;

CREATE TABLE courses (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done')),
  subject       TEXT,
  kind          TEXT NOT NULL DEFAULT 'course' CHECK (kind IN ('course','foundation')),  -- foundation：跨课程共享的学科基础
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE nodes (
  id            INTEGER PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES courses(id),
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('concept','definition','theorem','formula','method','problem_type')),
  usage         TEXT,
  definition    TEXT,
  intuition     TEXT,
  boundary      TEXT,
  pitfalls      TEXT,
  prereqs_reviewed_at TEXT,  -- 前置链最近一次确认完整的时间；NULL = 没梳理过
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, title)
);

CREATE TABLE assessments (
  id            INTEGER PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES courses(id),
  name          TEXT NOT NULL,
  exam_date     TEXT,
  exam_format   TEXT,
  scope_note    TEXT,
  status        TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','done','dropped')),
  UNIQUE (course_id, name)
);

-- 考核价值：只追加，最新一行为当前估计。没有资料时 value 留空、uncertainty='high'，不得凭空写"必考"。
CREATE TABLE node_values (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES nodes(id),
  assessment_id INTEGER NOT NULL REFERENCES assessments(id),
  value         INTEGER CHECK (value BETWEEN 0 AND 3),  -- 0 不考 · 1 低 · 2 中 · 3 高
  uncertainty   TEXT NOT NULL CHECK (uncertainty IN ('low','medium','high')),
  sources       TEXT,
  basis         TEXT NOT NULL,
  assessed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 边可以跨课程、跨学科。prerequisite_of 必须是 DAG（tools.ts 在写入时检查）。
CREATE TABLE edges (
  from_id       INTEGER NOT NULL REFERENCES nodes(id),
  to_id         INTEGER NOT NULL REFERENCES nodes(id),
  relation      TEXT NOT NULL CHECK (relation IN ('prerequisite_of','part_of','confused_with','contrasts_with','analogous_to')),
  note          TEXT,
  weight        INTEGER NOT NULL DEFAULT 2 CHECK (weight BETWEEN 1 AND 3),  -- 3 必需 · 2 重要 · 1 辅助；决定前置需要掌握到哪一级
  needed_layer  TEXT CHECK (needed_layer IN ('use','mechanism','principle','boundary')),  -- 讲到目标的哪一层才需要它；NULL = 任何层
  PRIMARY KEY (from_id, to_id, relation),
  CHECK (from_id <> to_id)
);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('past_paper','textbook','homework','teacher_sample','ai_generated')),
  source_ref    TEXT,
  format        TEXT CHECK (format IN ('choice','fill','calculation','proof','short_answer','other')),
  prompt        TEXT,
  answer        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 题目模型：一道题拆成步骤，每步对应一个节点；证据按步骤落到节点上。
CREATE TABLE task_steps (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  step_no       INTEGER NOT NULL,
  node_id       INTEGER NOT NULL REFERENCES nodes(id),
  description   TEXT,
  role          TEXT NOT NULL DEFAULT 'core' CHECK (role IN ('core','supporting')),
  UNIQUE (task_id, step_no)
);

CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY,
  course_id     INTEGER REFERENCES courses(id),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  planned_min   INTEGER,
  goal          TEXT,
  summary       TEXT
);

CREATE TABLE attempts (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER REFERENCES tasks(id),
  session_id    INTEGER REFERENCES sessions(id),
  answered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  context       TEXT NOT NULL CHECK (context IN ('right_after_teaching','delayed','mixed','timed','unseen_variant')),
  hints         TEXT NOT NULL CHECK (hints IN ('none','partial','full')),
  overall       TEXT NOT NULL CHECK (overall IN ('correct','partial','wrong')),
  confidence    INTEGER CHECK (confidence BETWEEN 0 AND 100),  -- 只在学生说了或被问到时填，不要编造
  self_signal   TEXT CHECK (self_signal IN ('sure','unsure','guessed')),
  seconds_spent INTEGER,
  note          TEXT
);

-- 证据：一道题做错，只给真正出错的那一步记 failed；没做到的步骤记 not_reached（不算证据）。
-- qualifier：guessed / lucky_path 的 demonstrated 不算掌握，slip 的 failed 不算缺口（见 rule_baseline）。
CREATE TABLE evidence (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES nodes(id),
  attempt_id    INTEGER REFERENCES attempts(id),
  step_id       INTEGER REFERENCES task_steps(id),
  session_id    INTEGER REFERENCES sessions(id),
  observed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  kind          TEXT NOT NULL CHECK (kind IN (
                  'step',
                  'exposure',
                  'prediction',
                  'self_explain',
                  'self_report'
                )),
  outcome       TEXT CHECK (outcome IN ('demonstrated','failed','not_reached','unclear')),
  qualifier     TEXT CHECK (qualifier IN (
                  'guessed',
                  'slip',
                  'lucky_path'
                )),
  representation TEXT CHECK (representation IN (
                  'verbal',
                  'worked_example',
                  'faded_example',
                  'counterexample',
                  'graph',
                  'numeric',
                  'formal',
                  'analogy',
                  'hands_on'
                )),
  interpretation TEXT,  -- 学生实际在用的规则，尤其是理解偏差
  note          TEXT,
  CHECK (kind <> 'step' OR (attempt_id IS NOT NULL AND outcome IS NOT NULL))
);

CREATE TABLE evidence_difficulties (
  evidence_id   INTEGER NOT NULL REFERENCES evidence(id),
  difficulty    TEXT NOT NULL CHECK (difficulty IN (
                  'unknown_concept',
                  'condition',
                  'recognition',
                  'execution',
                  'transfer',
                  'forgetting'
                )),
  PRIMARY KEY (evidence_id, difficulty)
);

-- 知识状态：只追加不修改，最新一行即当前状态。
CREATE TABLE knowledge_states (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES nodes(id),
  assessed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  level         TEXT NOT NULL CHECK (level IN (
                  'unknown',
                  'exposed',
                  'assisted',
                  'independent',
                  'validated',
                  'weak',
                  'recheck'
                )),
  weak_point    TEXT,
  basis         TEXT NOT NULL,
  rationale     TEXT,
  assessed_by   TEXT NOT NULL CHECK (assessed_by IN ('rule','ai','self'))
);

CREATE TABLE decisions (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER REFERENCES nodes(id),
  course_id     INTEGER REFERENCES courses(id),
  state_id      INTEGER REFERENCES knowledge_states(id),
  decided_at    TEXT NOT NULL DEFAULT (datetime('now')),
  assessment_id INTEGER REFERENCES assessments(id),
  action        TEXT NOT NULL CHECK (action IN ('diagnose','explain','practice','retest','advance','learn','skim','skip')),
  reason        TEXT NOT NULL,
  condition     TEXT,
  priority      INTEGER CHECK (priority BETWEEN 1 AND 3),
  -- planned 一次性动作待执行 · active 持续生效的范围决定（learn/skim/skip）· done · revoked
  status        TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
                  'planned',
                  'active',
                  'done',
                  'revoked'
                )),
  revoked_at    TEXT,
  revoked_why   TEXT,
  superseded_by INTEGER REFERENCES decisions(id),
  done_session  INTEGER REFERENCES sessions(id),
  outcome       TEXT
);

CREATE INDEX idx_nodes_course     ON nodes(course_id);
CREATE INDEX idx_edges_to         ON edges(to_id, relation);
CREATE INDEX idx_evidence_node    ON evidence(node_id, observed_at);
CREATE INDEX idx_states_node      ON knowledge_states(node_id, assessed_at);
CREATE INDEX idx_decisions_open   ON decisions(status, priority);
CREATE INDEX idx_values_node      ON node_values(node_id, assessment_id, assessed_at);

-- 没有评估过的节点视为 unknown。
CREATE VIEW current_state AS
SELECT n.id AS node_id, n.course_id, n.title,
       COALESCE(s.level, 'unknown') AS level,
       s.weak_point, s.assessed_at, s.assessed_by, s.rationale
FROM nodes n
LEFT JOIN knowledge_states s
  ON s.id = (SELECT id FROM knowledge_states k WHERE k.node_id = n.id
             ORDER BY assessed_at DESC, id DESC LIMIT 1);

-- 只看证据的机械判断，供 AI 写状态前参考，不直接当结论。
-- 最近一步做错 → weak；但之后有做对的随堂检查或自己解释（补救过）→ assisted。
-- independent 满 30 天、validated 满 60 天没有任何新证据 → recheck。
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

CREATE VIEW current_values AS
SELECT v.* FROM node_values v
WHERE v.id = (SELECT id FROM node_values w
              WHERE w.node_id = v.node_id AND w.assessment_id = v.assessment_id
              ORDER BY assessed_at DESC, id DESC LIMIT 1);

CREATE VIEW open_decisions AS
SELECT d.*, n.title, cv.value AS exam_value, cv.uncertainty AS value_uncertainty
FROM decisions d
LEFT JOIN nodes n ON n.id = d.node_id
LEFT JOIN current_values cv ON cv.node_id = d.node_id AND cv.assessment_id = d.assessment_id
WHERE d.status IN ('planned','active')
ORDER BY d.status, d.priority, cv.value DESC, d.decided_at;
