export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TOKEN: string;
}

export class ToolError extends Error {}

type Json = Record<string, unknown>;
type Schema = Json;

interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  readOnly?: boolean;
  destructive?: boolean;
  run: (env: Env, args: Json) => Promise<unknown>;
}

// These lists mirror the CHECK constraints in schema.sql. Changing one means a migration (SQLite
// cannot alter a CHECK in place, see migrations/0003) and updating the tool descriptions below.
const KINDS = ['concept', 'definition', 'theorem', 'formula', 'method', 'problem_type'];
const RELATIONS = ['prerequisite_of', 'part_of', 'confused_with', 'contrasts_with', 'analogous_to'];
const LAYERS = ['use', 'mechanism', 'principle', 'boundary'];
const COURSE_KINDS = ['course', 'foundation'];
const TASK_SOURCES = ['past_paper', 'textbook', 'homework', 'teacher_sample', 'ai_generated'];
const FORMATS = ['choice', 'fill', 'calculation', 'proof', 'short_answer', 'other'];
const CONTEXTS = ['right_after_teaching', 'delayed', 'mixed', 'timed', 'unseen_variant'];
const HINTS = ['none', 'partial', 'full'];
const OVERALL = ['correct', 'partial', 'wrong'];
const SELF_SIGNALS = ['sure', 'unsure', 'guessed'];
const OUTCOMES = ['demonstrated', 'failed', 'not_reached', 'unclear'];
const QUALIFIERS = ['guessed', 'slip', 'lucky_path'];
const DIFFICULTIES = ['unknown_concept', 'condition', 'recognition', 'execution', 'transfer', 'forgetting'];
const LEVELS = ['unknown', 'exposed', 'assisted', 'independent', 'validated', 'weak', 'recheck'];
const VALUE_SOURCES = ['syllabus', 'past_paper', 'teacher', 'homework', 'textbook', 'guess'];
const UNCERTAINTY = ['low', 'medium', 'high'];
const REPRESENTATIONS = ['verbal', 'worked_example', 'faded_example', 'counterexample', 'graph', 'numeric', 'formal', 'analogy', 'hands_on'];
const LIGHT_KINDS = ['exposure', 'prediction', 'self_explain', 'self_report'];
const ACTIONS = ['diagnose', 'explain', 'practice', 'retest', 'advance', 'learn', 'skim', 'skip'];
const SCOPE_ACTIONS = ['learn', 'skim', 'skip'];

const int = (description: string): Schema => ({ type: 'integer', description });
const str = (description: string): Schema => ({ type: 'string', description });
const oneOf = (values: string[], description: string): Schema => ({ type: 'string', enum: values, description });
const obj = (properties: Json, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

// Callers are LLMs: they send "5" for 5 and invent argument names. Numeric strings are coerced; an
// unknown name is rejected with the allowed list, because silently dropping it loses what the model
// meant to record. null means "not given" unless the schema allows null (estimate_value.value).
function conform(schema: Schema, value: unknown, path: string): unknown {
  const types = ([] as string[]).concat((schema.type as string | string[] | undefined) ?? []);
  const at = path || 'arguments';
  if (value === null && types.includes('null')) return null;
  const type = types.find((t) => t !== 'null');
  if (type === 'integer') {
    const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolError(`${at} must be an integer`);
    const { minimum, maximum } = schema as { minimum?: number; maximum?: number };
    if ((minimum !== undefined && n < minimum) || (maximum !== undefined && n > maximum))
      throw new ToolError(`${at} must be between ${minimum} and ${maximum}`);
    return n;
  }
  if (type === 'boolean') {
    if (value === 'true' || value === 'false') return value === 'true';
    if (typeof value !== 'boolean') throw new ToolError(`${at} must be true or false`);
    return value;
  }
  if (type === 'string') {
    const v = typeof value === 'number' ? String(value) : value;
    if (typeof v !== 'string') throw new ToolError(`${at} must be a string`);
    const allowed = schema.enum as string[] | undefined;
    if (allowed && v !== '' && !allowed.includes(v)) throw new ToolError(`${at} must be one of: ${allowed.join(', ')}`);
    return v;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new ToolError(`${at} must be an array`);
    return value.map((v, i) => conform(schema.items as Schema, v, `${path}[${i}]`));
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ToolError(`${at} must be an object`);
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      const key = path ? `${path}.${k}` : k;
      if (!(k in props)) throw new ToolError(`unknown argument: ${key}. Allowed: ${Object.keys(props).join(', ')}`);
      if (v === undefined || (v === null && !([] as string[]).concat((props[k].type as string | string[]) ?? []).includes('null'))) continue;
      out[k] = conform(props[k], v, key);
    }
    for (const k of (schema.required ?? []) as string[])
      if (out[k] === undefined || out[k] === '') throw new ToolError(`missing required argument: ${path ? `${path}.${k}` : k}`);
    return out;
  }
  return value;
}

function need<T>(args: Json, key: string): T {
  const v = args[key];
  if (v === undefined || v === null || v === '') throw new ToolError(`missing required argument: ${key}`);
  return v as T;
}
function opt<T>(args: Json, key: string): T | null {
  const v = args[key];
  return v === undefined || v === '' ? null : (v as T);
}
function inEnum(value: unknown, allowed: string[], key: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || !allowed.includes(value))
    throw new ToolError(`${key} must be one of: ${allowed.join(', ')}`);
}

async function first<T = Json>(env: Env, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await env.DB.prepare(sql).bind(...params).first<T>()) ?? null;
}
async function all<T = Json>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}
async function insertId(env: Env, sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql + ' RETURNING id').bind(...params).first<{ id: number }>();
  if (!row) throw new ToolError('insert failed');
  return row.id;
}
async function mustExist(env: Env, table: string, id: number, label = table): Promise<Json> {
  const row = await first(env, `SELECT * FROM ${table} WHERE id = ?`, id);
  if (!row) throw new ToolError(`${label} ${id} not found`);
  return row;
}

// A planned decision is stale once the node was re-assessed after the decision was made.
const STALE_SQL = `(d.status = 'planned' AND EXISTS (SELECT 1 FROM knowledge_states k WHERE k.node_id = d.node_id AND k.assessed_at > d.decided_at))`;

async function plannedFor(env: Env, nodeIds: number[]) {
  if (!nodeIds.length) return [];
  return all(
    env,
    `SELECT d.id, d.node_id, d.action, d.reason, d.decided_at, ${STALE_SQL} AS stale
     FROM decisions d WHERE d.status = 'planned' AND d.node_id IN (${nodeIds.map(() => '?').join(',')})
     ORDER BY d.decided_at`,
    ...nodeIds,
  );
}

// Run before any write: a record_* call that fails after writing gets retried by the model and
// leaves duplicate attempts/evidence behind.
async function checkExecutable(env: Env, decisionId: number, nodeIds: number[]) {
  const d = await mustExist(env, 'decisions', decisionId, 'decision');
  if (d.status !== 'planned') throw new ToolError(`decision ${decisionId} is ${d.status}, not planned`);
  if (d.node_id !== null && !nodeIds.includes(d.node_id as number))
    throw new ToolError(`decision ${decisionId} is about node ${d.node_id}, not the node(s) recorded here`);
}

async function completeDecision(env: Env, decisionId: number, sessionId: number | null, outcome: string | null) {
  await env.DB.prepare(
    `UPDATE decisions SET status = 'done', done_session = COALESCE(?, done_session), outcome = COALESCE(?, outcome) WHERE id = ?`,
  )
    .bind(sessionId, outcome, decisionId)
    .run();
  return decisionId;
}

// Decisions are never closed implicitly; the hint nudges the AI to close or revoke them explicitly.
const CLOSE_HINT =
  'These planned decisions on the same node(s) are still open. If one was just carried out, close it with update_decision (status done, with outcome); if new evidence makes it unnecessary, revoke it with a reason. Leave it only if it still applies.';

const executesSchema = {
  executes_decision_id: int('Id of the planned decision this activity carried out; it is marked done'),
  decision_outcome: str('What came of carrying out that decision'),
};

// FKs have no ON DELETE actions, so delete_record cascades by hand in one atomic D1 batch.
// Id sets are bound as a single JSON parameter (json_each) to stay under D1's bound-parameter limit.
const DELETE_TARGETS: Record<string, { table: string; label: string }> = {
  course: { table: 'courses', label: 'name' },
  node: { table: 'nodes', label: 'title' },
  assessment: { table: 'assessments', label: 'name' },
  task: { table: 'tasks', label: 'source_ref' },
  session: { table: 'sessions', label: 'goal' },
  attempt: { table: 'attempts', label: 'note' },
  evidence: { table: 'evidence', label: 'note' },
  state: { table: 'knowledge_states', label: 'level' },
  decision: { table: 'decisions', label: 'action' },
  value: { table: 'node_values', label: 'basis' },
};

const IN = 'IN (SELECT value FROM json_each(?))';

async function ids(env: Env, sql: string, ...params: unknown[]): Promise<number[]> {
  return (await all<{ id: number }>(env, sql, ...params)).map((r) => r.id);
}

async function deletionPlan(env: Env, target: string, id: number) {
  const j = (xs: number[]) => JSON.stringify(xs);
  const pick = (t: string) => (t === target ? [id] : []);
  const C = pick('course');
  const N = [...new Set([...pick('node'), ...(await ids(env, `SELECT id FROM nodes WHERE course_id ${IN}`, j(C)))])];
  const As = [...pick('assessment'), ...(await ids(env, `SELECT id FROM assessments WHERE course_id ${IN}`, j(C)))];
  const S = [...pick('session'), ...(await ids(env, `SELECT id FROM sessions WHERE course_id ${IN}`, j(C)))];
  // A task goes with the deleted nodes only if every one of its steps is on a deleted node.
  const T = [
    ...new Set([
      ...pick('task'),
      ...(await ids(
        env,
        `SELECT t.id FROM tasks t WHERE EXISTS (SELECT 1 FROM task_steps s WHERE s.task_id = t.id AND s.node_id ${IN})
           AND NOT EXISTS (SELECT 1 FROM task_steps s WHERE s.task_id = t.id AND s.node_id NOT ${IN})`,
        j(N),
        j(N),
      )),
    ]),
  ];
  const A = [
    ...new Set([
      ...pick('attempt'),
      ...(await ids(env, `SELECT id FROM attempts WHERE task_id ${IN} OR session_id ${IN}`, j(T), j(S))),
    ]),
  ];
  const steps = await ids(env, `SELECT id FROM task_steps WHERE task_id ${IN} OR node_id ${IN}`, j(T), j(N));
  const E = [
    ...new Set([
      ...pick('evidence'),
      ...(await ids(env, `SELECT id FROM evidence WHERE node_id ${IN} OR attempt_id ${IN} OR session_id ${IN}`, j(N), j(A), j(S))),
    ]),
  ];
  const K = [...new Set([...pick('state'), ...(await ids(env, `SELECT id FROM knowledge_states WHERE node_id ${IN}`, j(N)))])];
  const D = [
    ...new Set([
      ...pick('decision'),
      ...(await ids(env, `SELECT id FROM decisions WHERE node_id ${IN} OR course_id ${IN} OR assessment_id ${IN}`, j(N), j(C), j(As))),
    ]),
  ];
  const V = [
    ...new Set([...pick('value'), ...(await ids(env, `SELECT id FROM node_values WHERE node_id ${IN} OR assessment_id ${IN}`, j(N), j(As)))]),
  ];
  const edges = (
    await first<{ n: number }>(env, `SELECT COUNT(*) AS n FROM edges WHERE from_id ${IN} OR to_id ${IN}`, j(N), j(N))
  )!.n;

  const p = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params);
  // Order matters: null out references into the deleted sets before deleting rows.
  const statements = [
    p(`UPDATE decisions SET superseded_by = NULL WHERE superseded_by ${IN}`, j(D)),
    p(`UPDATE decisions SET state_id = NULL WHERE state_id ${IN}`, j(K)),
    p(`UPDATE decisions SET done_session = NULL WHERE done_session ${IN}`, j(S)),
    p(`DELETE FROM decisions WHERE id ${IN}`, j(D)),
    p(`DELETE FROM evidence_difficulties WHERE evidence_id ${IN}`, j(E)),
    p(`UPDATE evidence SET session_id = NULL WHERE session_id ${IN}`, j(S)),
    p(`UPDATE evidence SET step_id = NULL WHERE step_id ${IN}`, j(steps)),
    p(`DELETE FROM evidence WHERE id ${IN}`, j(E)),
    p(`UPDATE attempts SET session_id = NULL WHERE session_id ${IN}`, j(S)),
    p(`DELETE FROM attempts WHERE id ${IN}`, j(A)),
    p(`DELETE FROM task_steps WHERE id ${IN}`, j(steps)),
    p(`DELETE FROM tasks WHERE id ${IN}`, j(T)),
    p(`DELETE FROM knowledge_states WHERE id ${IN}`, j(K)),
    p(`DELETE FROM node_values WHERE id ${IN}`, j(V)),
    p(`DELETE FROM edges WHERE from_id ${IN} OR to_id ${IN}`, j(N), j(N)),
    p(`DELETE FROM nodes WHERE id ${IN}`, j(N)),
    p(`DELETE FROM assessments WHERE id ${IN}`, j(As)),
    p(`DELETE FROM sessions WHERE id ${IN}`, j(S)),
    p(`DELETE FROM courses WHERE id ${IN}`, j(C)),
  ];

  // knowledge_states.basis is a JSON array of evidence ids with no FK; surviving states that cite
  // deleted evidence are reported so the caller can re-assess them.
  const citing = E.length
    ? await all(
        env,
        `SELECT k.id AS state_id, k.node_id, n.title, k.level FROM knowledge_states k JOIN nodes n ON n.id = k.node_id
         WHERE k.id NOT ${IN} AND EXISTS (SELECT 1 FROM json_each(k.basis) b WHERE b.value ${IN})`,
        j(K),
        j(E),
      )
    : [];
  const nodeTitles = N.length
    ? await all(env, `SELECT id, title FROM nodes WHERE id ${IN} ORDER BY id LIMIT 30`, j(N))
    : [];
  const counts = {
    courses: C.length,
    nodes: N.length,
    edges,
    assessments: As.length,
    node_values: V.length,
    tasks: T.length,
    task_steps: steps.length,
    sessions: S.length,
    attempts: A.length,
    evidence: E.length,
    knowledge_states: K.length,
    decisions: D.length,
  };
  return { counts, statements, citing, nodeTitles };
}

// overview / courseTree / nodeDetail also back the web /api routes: keep their shapes in sync with web/src/lib/api.ts.
export async function overview(env: Env, courseId: number | null) {
  const courses = await all(
    env,
    `SELECT c.*,
       (SELECT COUNT(*) FROM nodes n WHERE n.course_id = c.id) AS node_count
     FROM courses c ${courseId ? 'WHERE c.id = ?' : ''} ORDER BY c.status, c.name`,
    ...(courseId ? [courseId] : []),
  );
  const assessments = await all(
    env,
    `SELECT * FROM assessments ${courseId ? 'WHERE course_id = ?' : ''} ORDER BY exam_date IS NULL, exam_date`,
    ...(courseId ? [courseId] : []),
  );
  const levels = await all(
    env,
    `SELECT course_id, level, COUNT(*) AS n FROM current_state ${courseId ? 'WHERE course_id = ?' : ''}
     GROUP BY course_id, level`,
    ...(courseId ? [courseId] : []),
  );
  // Planned first: the list is capped, and a long tail of active skip/skim scope decisions must not
  // push the next steps out of it.
  const decisions = await all(
    env,
    `SELECT d.id, d.node_id, n.title, COALESCE(d.course_id, n.course_id) AS course_id, c.name AS course, d.assessment_id,
            d.action, d.reason, d.condition, d.priority, d.status, cv.value AS exam_value, d.decided_at, ${STALE_SQL} AS stale
     FROM decisions d
     LEFT JOIN nodes n ON n.id = d.node_id
     LEFT JOIN courses c ON c.id = COALESCE(d.course_id, n.course_id)
     LEFT JOIN current_values cv ON cv.node_id = d.node_id AND cv.assessment_id = d.assessment_id
     WHERE d.status IN ('planned','active') ${courseId ? 'AND COALESCE(d.course_id, n.course_id) = ?' : ''}
     ORDER BY d.status DESC, d.priority IS NULL, d.priority, cv.value DESC, d.decided_at
     LIMIT 50`,
    ...(courseId ? [courseId] : []),
  );
  const lastSessions = await all(
    env,
    `SELECT s.*, c.name AS course FROM sessions s LEFT JOIN courses c ON c.id = s.course_id
     ${courseId ? 'WHERE s.course_id = ?' : ''} ORDER BY s.started_at DESC, s.id DESC LIMIT 3`,
    ...(courseId ? [courseId] : []),
  );
  return {
    courses: courses.map((c) => ({
      ...c,
      assessments: assessments.filter((a) => a.course_id === c.id),
      levels: Object.fromEntries(levels.filter((l) => l.course_id === c.id).map((l) => [l.level, l.n])),
    })),
    open_decisions: decisions,
    last_sessions: lastSessions,
  };
}

export async function courseTree(env: Env, courseId: number) {
  const course = await mustExist(env, 'courses', courseId, 'course');
  const assessments = await all(env, `SELECT * FROM assessments WHERE course_id = ? ORDER BY exam_date`, courseId);
  const nodes = await all(
    env,
    `SELECT n.id, n.title, n.kind, n.definition, s.level, s.weak_point, s.assessed_at, b.suggested_level, b.last_seen
     FROM nodes n
     JOIN current_state s ON s.node_id = n.id
     JOIN rule_baseline b ON b.node_id = n.id
     WHERE n.course_id = ? ORDER BY n.id`,
    courseId,
  );
  const values = await all(
    env,
    `SELECT v.node_id, v.assessment_id, v.value, v.uncertainty FROM current_values v
     JOIN nodes n ON n.id = v.node_id WHERE n.course_id = ?`,
    courseId,
  );
  const edges = await all(
    env,
    `SELECT e.* FROM edges e
     WHERE e.from_id IN (SELECT id FROM nodes WHERE course_id = ?) OR e.to_id IN (SELECT id FROM nodes WHERE course_id = ?)`,
    courseId,
    courseId,
  );
  const external = await all(
    env,
    `SELECT n.id, n.title, n.kind, n.course_id, c.name AS course, c.subject, s.level
     FROM nodes n JOIN courses c ON c.id = n.course_id JOIN current_state s ON s.node_id = n.id
     WHERE n.course_id <> ? AND n.id IN (
       SELECT e.from_id FROM edges e JOIN nodes t ON t.id = e.to_id WHERE t.course_id = ?
       UNION SELECT e.to_id FROM edges e JOIN nodes f ON f.id = e.from_id WHERE f.course_id = ?)`,
    courseId,
    courseId,
    courseId,
  );
  const scope = await all(
    env,
    `SELECT node_id, assessment_id, action, reason, condition FROM decisions
     WHERE status = 'active' AND action IN ('learn','skim','skip')
       AND node_id IN (SELECT id FROM nodes WHERE course_id = ?)`,
    courseId,
  );
  return { course, assessments, nodes, values, edges, external_nodes: external, scope_decisions: scope };
}

const EDGE_COLS = `e.relation, e.note, e.weight, e.needed_layer, n.id AS node_id, n.title, n.course_id, c.name AS course, c.subject, s.level`;
const EDGE_JOIN = `JOIN courses c ON c.id = n.course_id JOIN current_state s ON s.node_id = n.id`;

export async function nodeDetail(env: Env, nodeId: number) {
  const node = await first(
    env,
    `SELECT n.*, c.name AS course, c.subject, c.kind AS course_kind FROM nodes n JOIN courses c ON c.id = n.course_id WHERE n.id = ?`,
    nodeId,
  );
  if (!node) throw new ToolError(`node ${nodeId} not found`);
  const [edgesOut, edgesIn, states, values, evidence, decisions, baseline, representations] = await Promise.all([
    all(env, `SELECT ${EDGE_COLS} FROM edges e JOIN nodes n ON n.id = e.to_id ${EDGE_JOIN} WHERE e.from_id = ?`, nodeId),
    all(env, `SELECT ${EDGE_COLS} FROM edges e JOIN nodes n ON n.id = e.from_id ${EDGE_JOIN} WHERE e.to_id = ?`, nodeId),
    all(env, `SELECT * FROM knowledge_states WHERE node_id = ? ORDER BY assessed_at DESC, id DESC LIMIT 8`, nodeId),
    all(env, `SELECT v.*, a.name AS assessment FROM current_values v JOIN assessments a ON a.id = v.assessment_id WHERE v.node_id = ?`, nodeId),
    all(
      env,
      `SELECT e.id, e.kind, e.outcome, e.qualifier, e.representation, e.interpretation, e.note, e.observed_at, e.attempt_id,
              a.context, a.hints, a.overall, a.self_signal, a.confidence,
              t.source AS task_source, t.source_ref, t.prompt AS task_prompt,
              ts.step_no, ts.role, ts.description AS step_description,
              (SELECT json_group_array(difficulty) FROM evidence_difficulties d WHERE d.evidence_id = e.id) AS difficulties
       FROM evidence e
       LEFT JOIN attempts a ON a.id = e.attempt_id
       LEFT JOIN tasks t ON t.id = a.task_id
       LEFT JOIN task_steps ts ON ts.id = e.step_id
       WHERE e.node_id = ? ORDER BY e.observed_at DESC, e.id DESC LIMIT 20`,
      nodeId,
    ),
    all(env, `SELECT d.*, ${STALE_SQL} AS stale FROM decisions d WHERE d.node_id = ? ORDER BY d.decided_at DESC, d.id DESC LIMIT 10`, nodeId),
    first(env, `SELECT * FROM rule_baseline WHERE node_id = ?`, nodeId),
    all(
      env,
      `SELECT x.representation, COUNT(*) AS times_used, MAX(x.observed_at) AS last_used,
         (SELECT COUNT(*) FROM evidence p WHERE p.node_id = x.node_id AND p.kind = 'prediction'
            AND p.representation = x.representation AND p.outcome = 'failed') AS failed_checks
       FROM evidence x WHERE x.node_id = ? AND x.representation IS NOT NULL
       GROUP BY x.representation ORDER BY last_used DESC`,
      nodeId,
    ),
  ]);
  return {
    node,
    current_state: states[0] ?? { level: 'unknown' },
    state_history: states,
    rule_baseline: baseline,
    representations_tried: representations,
    values,
    edges: { outgoing: edgesOut, incoming: edgesIn },
    evidence: evidence.map((e) => ({ ...e, difficulties: JSON.parse(String(e.difficulties ?? '[]')) })),
    decisions,
  };
}

const LEVEL_RANK: Record<string, number> = { unknown: 0, exposed: 1, assisted: 2, independent: 3, validated: 4 };
// Mastery a prerequisite needs, by the weakest link weight on its path to the target.
const REQUIRED_LEVEL: Record<number, string> = { 3: 'independent', 2: 'assisted', 1: 'exposed' };
const LAYER_SQL = `CASE e.needed_layer WHEN 'use' THEN 1 WHEN 'mechanism' THEN 2 WHEN 'principle' THEN 3 WHEN 'boundary' THEN 4 ELSE 0 END`;

function prereqStatus(level: string, lastSeen: unknown, pathWeight: number): 'ok' | 'gap' | 'unverified' {
  if (level === 'weak') return 'gap';
  if (level === 'recheck') return 'unverified';
  if (level === 'unknown' && !lastSeen) return pathWeight >= 2 ? 'unverified' : 'ok';
  return (LEVEL_RANK[level] ?? 0) >= LEVEL_RANK[REQUIRED_LEVEL[pathWeight]] ? 'ok' : 'gap';
}

export async function prerequisiteChain(
  env: Env,
  nodeId: number,
  opts: { layer?: string | null; minWeight?: number | null; maxDepth?: number | null } = {},
) {
  const target = await first<Json>(
    env,
    `SELECT n.id, n.title, n.course_id, c.name AS course, c.subject, n.prereqs_reviewed_at, s.level
     FROM nodes n JOIN courses c ON c.id = n.course_id JOIN current_state s ON s.node_id = n.id WHERE n.id = ?`,
    nodeId,
  );
  if (!target) throw new ToolError(`node ${nodeId} not found`);
  const layer = opts.layer ?? 'boundary';
  inEnum(layer, LAYERS, 'layer');
  const layerRank = LAYERS.indexOf(layer) + 1;
  const minWeight = Math.max(1, Math.min(opts.minWeight ?? 1, 3));
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 4, 8));

  // The layer filter applies only to the first hop (what this explanation depth needs); further up,
  // everything a needed prerequisite rests on counts. `path` guards against cycles in bad data.
  const rows = await all<{ node_id: number; child_id: number; depth: number; weight: number; path_weight: number; needed_layer: string | null; note: string | null }>(
    env,
    `WITH RECURSIVE chain(node_id, child_id, depth, weight, path_weight, needed_layer, note, path) AS (
       SELECT e.from_id, e.to_id, 1, e.weight, e.weight, e.needed_layer, e.note, ',' || e.to_id || ',' || e.from_id || ','
       FROM edges e WHERE e.to_id = ? AND e.relation = 'prerequisite_of' AND e.weight >= ? AND ${LAYER_SQL} <= ?
       UNION ALL
       SELECT e.from_id, e.to_id, c.depth + 1, e.weight, min(c.path_weight, e.weight), e.needed_layer, e.note, c.path || e.from_id || ','
       FROM chain c JOIN edges e ON e.to_id = c.node_id AND e.relation = 'prerequisite_of'
       WHERE c.depth < ? AND e.weight >= ? AND instr(c.path, ',' || e.from_id || ',') = 0
     )
     SELECT node_id, child_id, depth, weight, path_weight, needed_layer, note FROM chain LIMIT 1000`,
    nodeId,
    minWeight,
    layerRank,
    maxDepth,
    minWeight,
  );

  const agg = new Map<number, { depth: number; path_weight: number; needed_for: Json[] }>();
  for (const r of rows) {
    const a = agg.get(r.node_id) ?? { depth: 0, path_weight: 0, needed_for: [] };
    a.depth = Math.max(a.depth, r.depth);
    a.path_weight = Math.max(a.path_weight, r.path_weight);
    if (!a.needed_for.some((x) => x.node_id === r.child_id))
      a.needed_for.push({ node_id: r.child_id, weight: r.weight, needed_layer: r.needed_layer, note: r.note });
    agg.set(r.node_id, a);
  }
  const ids = [...agg.keys()];
  const info = ids.length
    ? await all<Json>(
        env,
        `SELECT n.id, n.title, n.kind, n.course_id, c.name AS course, c.subject, n.prereqs_reviewed_at, s.level, b.last_seen,
           (SELECT COUNT(*) FROM edges e WHERE e.to_id = n.id AND e.relation = 'prerequisite_of') AS own_prereqs
         FROM nodes n JOIN courses c ON c.id = n.course_id JOIN current_state s ON s.node_id = n.id
         JOIN rule_baseline b ON b.node_id = n.id
         WHERE n.id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )
    : [];
  const prerequisites = info
    .map((n) => {
      const a = agg.get(n.id as number)!;
      return {
        node_id: n.id,
        title: n.title,
        kind: n.kind,
        course_id: n.course_id,
        course: n.course,
        subject: n.subject,
        cross_course: n.course_id !== target.course_id,
        depth: a.depth,
        path_weight: a.path_weight,
        required_level: REQUIRED_LEVEL[a.path_weight],
        level: n.level,
        last_seen: n.last_seen,
        status: prereqStatus(String(n.level), n.last_seen, a.path_weight),
        chain_reviewed: !!n.prereqs_reviewed_at,
        needed_for: a.needed_for,
        truncated: a.depth >= maxDepth && Number(n.own_prereqs) > 0 ? true : undefined,  // only where the walk stopped at max_depth but the chain continues
      };
    })
    // Deepest first is a valid teaching order on a DAG: a prerequisite always sits deeper than what it serves.
    .sort((x, y) => y.depth - x.depth || y.path_weight - x.path_weight || Number(x.node_id) - Number(y.node_id));

  const teachOrder = prerequisites.filter((p) => p.status !== 'ok');
  const unreviewed = prerequisites.filter((p) => !p.chain_reviewed && p.path_weight >= 2).map((p) => p.node_id);
  const hints: string[] = [];
  if (!target.prereqs_reviewed_at)
    hints.push(
      prerequisites.length
        ? 'The chain of this node has not been confirmed complete. Check that every prerequisite is linked (with weight and needed_layer), then call upsert_node with prereqs_reviewed=true.'
        : 'No prerequisites are recorded and the chain was never reviewed. Before explaining, work out what this node builds on, searching all courses with find_nodes (prerequisites often come from another subject); create missing ones with upsert_node (in a foundation course of their own subject when they belong to another discipline), link them with link_nodes (weight, needed_layer), then call upsert_node with prereqs_reviewed=true. If it truly needs nothing, just mark it reviewed.',
    );
  if (teachOrder.some((p) => p.status === 'unverified'))
    hints.push('unverified: no or outdated evidence. Run a 1-question check on these (weight 3 first) instead of assuming either way.');
  if (teachOrder.some((p) => p.status === 'gap'))
    hints.push('gap: below required_level. Repair these in teach_order (deepest first) before the target, only to the layer the target needs.');
  if (unreviewed.length)
    hints.push(`Prerequisites ${unreviewed.join(', ')} have not had their own chains reviewed; the chain above them may be incomplete.`);

  return {
    target,
    layer,
    min_weight: minWeight,
    max_depth: maxDepth,
    prerequisites,
    teach_order: teachOrder.map((p) => ({ node_id: p.node_id, title: p.title, course: p.course, status: p.status, required_level: p.required_level, level: p.level })),
    ready: target.prereqs_reviewed_at !== null && !teachOrder.length,
    ...(hints.length ? { hint: hints.join(' ') } : {}),
  };
}

// Attached to teaching writes so the AI is reminded to set up the chain before explaining further.
async function chainNotice(env: Env, nodeId: number) {
  const c = await prerequisiteChain(env, nodeId, { minWeight: 2, maxDepth: 1 });
  const gaps = c.teach_order.filter((p) => c.prerequisites.find((q) => q.node_id === p.node_id)?.path_weight === 3);
  if (c.target.prereqs_reviewed_at && !gaps.length) return null;
  return {
    prerequisite_chain: {
      reviewed: !!c.target.prereqs_reviewed_at,
      essential_gaps: gaps,
      hint: !c.target.prereqs_reviewed_at
        ? 'This node\'s prerequisite chain has not been set up. Call prerequisite_chain on it before (further) explaining.'
        : 'Essential (weight 3) prerequisites are not in place; repair them first or explain why it is fine to go on.',
    },
  };
}

const nodeId = int('Knowledge node id (look it up with find_nodes)');

export const TOOLS: Tool[] = [
  {
    name: 'overview',
    readOnly: true,
    description:
      'Start here. Lists courses with their assessments (exams), how many nodes sit in each knowledge state, open/active teaching decisions, and the last few session summaries (where the student stopped). A decision with stale=1 is planned but the node was re-assessed after it was made: before acting on it, check get_node and either carry it out, or close/revoke it with update_decision.',
    inputSchema: obj({ course_id: int('Limit to one course') }),
    run: (env, a) => overview(env, opt<number>(a, 'course_id')),
  },
  {
    name: 'find_nodes',
    readOnly: true,
    description:
      'Search knowledge nodes by title substring, course, subject and/or current state level. Omit course_id to search every course: prerequisites and analogies often live in another course or subject.',
    inputSchema: obj({
      query: str('Substring of the node title'),
      course_id: int('Course id'),
      subject: str('Subject of the course, e.g. 数学'),
      level: oneOf(LEVELS, 'Only nodes currently in this state'),
      limit: int('Max rows, default 30'),
    }),
    run: async (env, a) => {
      inEnum(opt(a, 'level'), LEVELS, 'level');
      const where: string[] = [];
      const params: unknown[] = [];
      const q = opt<string>(a, 'query');
      if (q) (where.push('n.title LIKE ?'), params.push(`%${q}%`));
      const c = opt<number>(a, 'course_id');
      if (c) (where.push('n.course_id = ?'), params.push(c));
      const sub = opt<string>(a, 'subject');
      if (sub) (where.push('co.subject = ?'), params.push(sub));
      const l = opt<string>(a, 'level');
      if (l) (where.push('s.level = ?'), params.push(l));
      params.push(Math.min(opt<number>(a, 'limit') ?? 30, 200));
      return all(
        env,
        `SELECT n.id, n.course_id, co.name AS course, co.subject, n.title, n.kind, s.level, s.assessed_at
         FROM nodes n JOIN current_state s ON s.node_id = n.id JOIN courses co ON co.id = n.course_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY n.course_id, n.id LIMIT ?`,
        ...params,
      );
    },
  },
  {
    name: 'get_node',
    readOnly: true,
    description:
      'Everything about one node: its facts, related nodes, current state and history, exam value per assessment, the most recent evidence (with task, step, context, hints, difficulty tags, representation and the student interpretation), which representations have been tried and how many embedded checks failed after each, decisions, and the mechanical rule_baseline suggestion.',
    inputSchema: obj({ node_id: nodeId }, ['node_id']),
    run: (env, a) => nodeDetail(env, need<number>(a, 'node_id')),
  },
  {
    name: 'prerequisite_chain',
    readOnly: true,
    description:
      'Call before explaining a node. Walks prerequisite_of links upstream (across courses and subjects) and, for each prerequisite, gives depth, path_weight (weakest link on the strongest path; 3 essential, 2 important, 1 helpful), required_level (weight 3 → independent, 2 → assisted, 1 → exposed), current level and status: ok, gap (below required) or unverified (no or outdated evidence). teach_order lists what to check or repair first, deepest first. layer = how deep this round will go (use, mechanism, principle, boundary): links whose needed_layer is deeper are left out. ready=true means the chain was reviewed and nothing needs repair. If it says the chain was never reviewed, build it first.',
    inputSchema: obj(
      {
        node_id: nodeId,
        layer: oneOf(LAYERS, 'Deepest explanation layer planned this round; default boundary (everything)'),
        min_weight: int('Ignore links lighter than this (1–3); default 1'),
        max_depth: int('How many links upstream; default 4'),
      },
      ['node_id'],
    ),
    run: (env, a) =>
      prerequisiteChain(env, need<number>(a, 'node_id'), {
        layer: opt<string>(a, 'layer'),
        minWeight: opt<number>(a, 'min_weight'),
        maxDepth: opt<number>(a, 'max_depth'),
      }),
  },
  {
    name: 'review_candidates',
    readOnly: true,
    description:
      'Nodes most worth checking next in a course: weak, recheck, assisted or exposed nodes, and independent/validated ones not seen for 14+ days, ordered by exam value. Nodes with an active skip decision are left out. Use this to choose the next task; it is a ranking aid, not a schedule.',
    inputSchema: obj(
      {
        course_id: int('Course id'),
        assessment_id: int('Rank by value for this assessment; default: the course\'s nearest upcoming assessment'),
        limit: int('Default 10'),
      },
      ['course_id'],
    ),
    run: async (env, a) => {
      const course = need<number>(a, 'course_id');
      await mustExist(env, 'courses', course, 'course');
      let assessment = opt<number>(a, 'assessment_id');
      if (assessment) await mustExist(env, 'assessments', assessment, 'assessment');
      else
        assessment =
          (
            await first<{ id: number }>(
              env,
              `SELECT id FROM assessments WHERE course_id = ? AND status = 'upcoming' ORDER BY exam_date IS NULL, exam_date, id LIMIT 1`,
              course,
            )
          )?.id ?? null;
      return all(
        env,
        `SELECT s.node_id, s.title, s.level, s.weak_point, b.suggested_level, b.last_seen,
                CAST(julianday('now') - julianday(b.last_seen) AS INTEGER) AS days_since_seen,
                v.value AS exam_value, v.uncertainty AS value_uncertainty
         FROM current_state s
         JOIN rule_baseline b ON b.node_id = s.node_id
         LEFT JOIN current_values v ON v.node_id = s.node_id AND v.assessment_id = ?
         WHERE s.course_id = ?
           AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.node_id = s.node_id AND d.status = 'active' AND d.action = 'skip')
           AND (s.level IN ('weak','recheck','assisted','exposed')
                OR (s.level IN ('independent','validated') AND julianday('now') - julianday(b.last_seen) >= 14)
                OR (s.level = 'unknown' AND b.last_seen IS NOT NULL))
         ORDER BY COALESCE(v.value, 1) DESC,
                  CASE s.level WHEN 'weak' THEN 0 WHEN 'recheck' THEN 1 WHEN 'assisted' THEN 2 WHEN 'exposed' THEN 3 ELSE 4 END,
                  b.last_seen
         LIMIT ?`,
        assessment,
        course,
        Math.min(opt<number>(a, 'limit') ?? 10, 50),
      );
    },
  },
  {
    name: 'upsert_course',
    description:
      'Create a course, or update it if a course with this name exists. Returns its id. kind=foundation makes a shared knowledge base for one subject (e.g. 线性代数基础, 概率论基础) that other courses link into, instead of copying basics into every course.',
    inputSchema: obj(
      {
        name: str('Course name'),
        status: oneOf(['active', 'paused', 'done'], 'Default active'),
        subject: str('Discipline, e.g. 数学 / 统计 / 计算机 / 经济 / 日语'),
        kind: oneOf(COURSE_KINDS, 'course (has exams; default) or foundation (shared subject basics)'),
      },
      ['name'],
    ),
    run: async (env, a) => {
      const status = opt<string>(a, 'status');
      inEnum(status, ['active', 'paused', 'done'], 'status');
      inEnum(opt(a, 'kind'), COURSE_KINDS, 'kind');
      const row = await first<{ id: number }>(
        env,
        `INSERT INTO courses (name, status, subject, kind) VALUES (?, COALESCE(?, 'active'), ?, COALESCE(?, 'course'))
         ON CONFLICT(name) DO UPDATE SET status = COALESCE(?, courses.status),
           subject = COALESCE(excluded.subject, courses.subject), kind = COALESCE(?, courses.kind)
         RETURNING id`,
        need<string>(a, 'name'),
        status,
        opt(a, 'subject'),
        opt(a, 'kind'),
        status,
        opt(a, 'kind'),
      );
      return { course_id: row?.id };
    },
  },
  {
    name: 'upsert_assessment',
    description:
      'Create or update an assessment target of a course (midterm, final, a qualifying exam…). Exam value is always estimated per assessment.',
    inputSchema: obj(
      {
        course_id: int('Course id'),
        name: str('e.g. 期末考试'),
        exam_date: str('YYYY-MM-DD'),
        exam_format: str('Question types and weights'),
        scope_note: str('Scope and where that information came from'),
        status: oneOf(['upcoming', 'done', 'dropped'], 'Default upcoming'),
      },
      ['course_id', 'name'],
    ),
    run: async (env, a) => {
      inEnum(opt(a, 'status'), ['upcoming', 'done', 'dropped'], 'status');
      await mustExist(env, 'courses', need<number>(a, 'course_id'), 'course');
      const row = await first<{ id: number }>(
        env,
        `INSERT INTO assessments (course_id, name, exam_date, exam_format, scope_note, status)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, 'upcoming'))
         ON CONFLICT(course_id, name) DO UPDATE SET
           exam_date = COALESCE(excluded.exam_date, assessments.exam_date),
           exam_format = COALESCE(excluded.exam_format, assessments.exam_format),
           scope_note = COALESCE(excluded.scope_note, assessments.scope_note),
           status = COALESCE(?, assessments.status)
         RETURNING id`,
        a.course_id,
        a.name,
        opt(a, 'exam_date'),
        opt(a, 'exam_format'),
        opt(a, 'scope_note'),
        opt(a, 'status'),
        opt(a, 'status'),
      );
      return { assessment_id: row?.id };
    },
  },
  {
    name: 'upsert_node',
    description:
      'Create a knowledge node, or fill in/replace facts of an existing node with the same course and title. Only facts about the knowledge itself belong here (definition, intuition, boundary conditions, common pitfalls); the student\'s state, exam value and learn/skip choices go elsewhere. Write every formula as LaTeX inside $...$ (inline) or $$...$$ (display), e.g. $P(y=1\\mid x)=\\sigma(w^\\top x+b)$; the web viewer renders only delimited LaTeX, so never use bare Unicode math like wᵀx or e^{w} without $ delimiters. The same applies to formulas in any other free-text field (notes, rationale, reasons).',
    inputSchema: obj(
      {
        course_id: int('Course id'),
        title: str('Node title, unique within the course'),
        kind: oneOf(KINDS, 'Node type'),
        usage: str('What problem it solves, when to reach for it, how to use it (layers 1-2)'),
        definition: str('Rigorous definition or formula'),
        intuition: str('Intuitive explanation'),
        boundary: str('Conditions and counterexamples'),
        pitfalls: str('Common mistakes in general, not this student\'s'),
        prereqs_reviewed: {
          type: 'boolean',
          description: 'true once all prerequisites of this node are linked (or it truly needs none); false to reopen',
        },
      },
      ['course_id', 'title', 'kind'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'kind'), KINDS, 'kind');
      await mustExist(env, 'courses', need<number>(a, 'course_id'), 'course');
      const row = await first<{ id: number }>(
        env,
        `INSERT INTO nodes (course_id, title, kind, usage, definition, intuition, boundary, pitfalls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(course_id, title) DO UPDATE SET
           kind = excluded.kind,
           usage = COALESCE(excluded.usage, nodes.usage),
           definition = COALESCE(excluded.definition, nodes.definition),
           intuition = COALESCE(excluded.intuition, nodes.intuition),
           boundary = COALESCE(excluded.boundary, nodes.boundary),
           pitfalls = COALESCE(excluded.pitfalls, nodes.pitfalls),
           prereqs_reviewed_at = CASE ? WHEN 1 THEN datetime('now') WHEN 0 THEN NULL ELSE nodes.prereqs_reviewed_at END
         RETURNING id`,
        a.course_id,
        need<string>(a, 'title'),
        a.kind,
        opt(a, 'usage'),
        opt(a, 'definition'),
        opt(a, 'intuition'),
        opt(a, 'boundary'),
        opt(a, 'pitfalls'),
        a.prereqs_reviewed === true ? 1 : a.prereqs_reviewed === false ? 0 : null,
      );
      // A new node marked reviewed in the same call: the INSERT path skips the CASE above.
      if (a.prereqs_reviewed === true)
        await env.DB.prepare(`UPDATE nodes SET prereqs_reviewed_at = datetime('now') WHERE id = ?`).bind(row?.id).run();
      return { node_id: row?.id };
    },
  },
  {
    name: 'link_nodes',
    description:
      'Add or update (or with remove=true delete) a relation between two nodes; the nodes may belong to different courses and subjects. prerequisite_of: from is needed before to; give weight (3 essential: cannot follow to without it; 2 important: gets stuck at some layer; 1 helpful background) and needed_layer (the layer of to that first needs it: use, mechanism, principle, boundary; omit if every layer needs it). part_of: from is a part of to. confused_with / contrasts_with: easily mixed up or worth contrasting. analogous_to: same structure in another subject, usable as an analogy; say in note where the analogy breaks. Prerequisite cycles are rejected.',
    inputSchema: obj(
      {
        from_id: int('From node id'),
        to_id: int('To node id'),
        relation: oneOf(RELATIONS, 'Relation'),
        note: str('Why; for prerequisites, what exactly of from is used in to'),
        weight: int('prerequisite_of only: 1–3, default 2'),
        needed_layer: oneOf(LAYERS, 'prerequisite_of only: first layer of to that needs from'),
        remove: { type: 'boolean', description: 'Delete the relation instead' },
      },
      ['from_id', 'to_id', 'relation'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'relation'), RELATIONS, 'relation');
      inEnum(opt(a, 'needed_layer'), LAYERS, 'needed_layer');
      const weight = opt<number>(a, 'weight');
      if (weight !== null && (!Number.isInteger(weight) || weight < 1 || weight > 3)) throw new ToolError('weight must be 1–3');
      if (a.relation !== 'prerequisite_of' && (weight !== null || opt(a, 'needed_layer')))
        throw new ToolError('weight and needed_layer only apply to prerequisite_of');
      if (a.remove === true) {
        const r = await env.DB.prepare('DELETE FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?')
          .bind(a.from_id, a.to_id, a.relation)
          .run();
        return { removed: r.meta.changes };
      }
      const from = await mustExist(env, 'nodes', need<number>(a, 'from_id'), 'node');
      const to = await mustExist(env, 'nodes', need<number>(a, 'to_id'), 'node');
      if (a.from_id === a.to_id) throw new ToolError('a node cannot relate to itself');
      if (a.relation === 'prerequisite_of') {
        // prerequisite_of must stay a DAG: reject an edge whose target is already upstream of its source.
        const cycle = await first<{ path: string }>(
          env,
          `WITH RECURSIVE up(id, path) AS (
             SELECT ?, ',' || ? || ','
             UNION ALL
             SELECT e.from_id, up.path || e.from_id || ',' FROM up JOIN edges e ON e.to_id = up.id AND e.relation = 'prerequisite_of'
             WHERE instr(up.path, ',' || e.from_id || ',') = 0 AND length(up.path) < 2000
           )
           SELECT path FROM up WHERE id = ? LIMIT 1`,
          a.from_id,
          a.from_id,
          a.to_id,
        );
        if (cycle)
          throw new ToolError(
            `cycle: node ${a.to_id} is already a prerequisite of node ${a.from_id} (path ${cycle.path.split(',').filter(Boolean).reverse().join(' → ')}). Split the knowledge into finer nodes, or use contrasts_with / analogous_to.`,
          );
      }
      await env.DB.prepare(
        `INSERT INTO edges (from_id, to_id, relation, note, weight, needed_layer) VALUES (?, ?, ?, ?, COALESCE(?, 2), ?)
         ON CONFLICT DO UPDATE SET note = COALESCE(excluded.note, edges.note),
           weight = COALESCE(?, edges.weight), needed_layer = COALESCE(excluded.needed_layer, edges.needed_layer)`,
      )
        .bind(a.from_id, a.to_id, a.relation, opt(a, 'note'), weight, opt(a, 'needed_layer'), weight)
        .run();
      return { ok: true, cross_course: from.course_id !== to.course_id };
    },
  },
  {
    name: 'move_node',
    description:
      'Move a node to another course, e.g. a basic that was filed under an applied course into the foundation course of its own subject. Evidence, states, values, decisions and links stay with the node.',
    inputSchema: obj({ node_id: nodeId, course_id: int('Target course id') }, ['node_id', 'course_id']),
    run: async (env, a) => {
      const node = await mustExist(env, 'nodes', need<number>(a, 'node_id'), 'node');
      await mustExist(env, 'courses', need<number>(a, 'course_id'), 'course');
      if (await first(env, 'SELECT id FROM nodes WHERE course_id = ? AND title = ? AND id <> ?', a.course_id, node.title, a.node_id))
        throw new ToolError(`course ${a.course_id} already has a node titled ${node.title}`);
      await env.DB.prepare('UPDATE nodes SET course_id = ? WHERE id = ?').bind(a.course_id, a.node_id).run();
      return { ok: true, from_course_id: node.course_id };
    },
  },
  {
    name: 'delete_record',
    description:
      'Delete a wrongly created or duplicate record, together with everything that depends on it. target: course (its nodes, assessments, sessions and all their records), node (its links, evidence, states, values, decisions, and questions whose every step is on this node), assessment (its exam values and the decisions made for it), task (the question with its steps, attempts and their evidence), session (its attempts and evidence; decisions carried out in it lose the session reference), attempt (with its step evidence), evidence, state, decision, value. Deletion cannot be undone. Call first WITHOUT confirm: nothing is deleted and you get exactly what would go. Show that to the student in plain words and set confirm=true only after the student explicitly agrees in this conversation. Do not delete to correct the learning history: a wrong judgement is superseded by a new assess_state, and a decision that no longer holds is revoked with update_decision. To file a node under another course use move_node; to drop a single relation use link_nodes with remove=true.',
    inputSchema: obj(
      {
        target: oneOf(Object.keys(DELETE_TARGETS), 'What kind of record to delete'),
        id: int('Its id'),
        confirm: { type: 'boolean', description: 'true to actually delete (only after the student agreed to the preview); omit for a preview' },
      },
      ['target', 'id'],
    ),
    destructive: true,
    run: async (env, a) => {
      const target = need<string>(a, 'target');
      inEnum(target, Object.keys(DELETE_TARGETS), 'target');
      const { table, label } = DELETE_TARGETS[target];
      const row = await mustExist(env, table, need<number>(a, 'id'), target);
      const plan = await deletionPlan(env, target, a.id as number);
      const will_delete = Object.fromEntries(Object.entries(plan.counts).filter(([, n]) => n > 0));
      const summary = {
        target: { kind: target, id: a.id, label: row[label] ?? null },
        will_delete,
        ...(plan.nodeTitles.length && target !== 'node' ? { nodes: plan.nodeTitles } : {}),
        ...(plan.citing.length ? { states_citing_deleted_evidence: plan.citing } : {}),
      };
      if (a.confirm !== true)
        return {
          preview: true,
          ...summary,
          hint: 'Nothing was deleted. Tell the student what will be removed and that it cannot be undone; call again with confirm=true only after they agree.' +
            (plan.citing.length ? ' Some remaining states cite evidence that will be deleted; reassess those nodes afterwards.' : ''),
        };
      await env.DB.batch(plan.statements);
      return {
        deleted: true,
        ...summary,
        deleted_row: row,
        ...(plan.citing.length ? { hint: 'Reassess the nodes listed in states_citing_deleted_evidence with assess_state.' } : {}),
      };
    },
  },
  {
    name: 'start_session',
    description: 'Open a study session. Returns session_id to attach evidence to.',
    inputSchema: obj({
      course_id: int('Course id'),
      planned_min: int('Minutes the student has'),
      goal: str('应考 / 新概念 / 查漏补缺 / 巩固, in the student\'s words'),
    }),
    run: async (env, a) => {
      const course = opt<number>(a, 'course_id');
      if (course) await mustExist(env, 'courses', course, 'course');
      return {
        session_id: await insertId(
          env,
          'INSERT INTO sessions (course_id, planned_min, goal) VALUES (?, ?, ?)',
          course,
          opt(a, 'planned_min'),
          opt(a, 'goal'),
        ),
      };
    },
  },
  {
    name: 'end_session',
    description:
      'Save the short end-of-session record: what was done, independent performance, where to start next time, what can be skipped for now. Returns any planned decisions on nodes studied in this session that are still open; close or revoke them before finishing.',
    inputSchema: obj({ session_id: int('Session id'), summary: str('Micro learning record') }, ['session_id', 'summary']),
    run: async (env, a) => {
      await mustExist(env, 'sessions', need<number>(a, 'session_id'), 'session');
      await env.DB.prepare('UPDATE sessions SET summary = ? WHERE id = ?').bind(need(a, 'summary'), a.session_id).run();
      const touched = await all<{ node_id: number }>(env, 'SELECT DISTINCT node_id FROM evidence WHERE session_id = ?', a.session_id);
      const open = await plannedFor(env, touched.map((t) => t.node_id));
      return open.length
        ? { ok: true, unclosed_decisions: open, hint: 'Nodes studied in this session still have planned decisions. ' + CLOSE_HINT }
        : { ok: true };
    },
  },
  {
    name: 'record_attempt',
    description:
      'Record one answered question. Describe the question as a task with steps, each step mapped to the node it exercises (core = what the question mainly tests, supporting = used along the way). Then give one result per step: demonstrated, failed, not_reached (never got there: no evidence either way) or unclear. A wrong answer only counts against the step that actually failed. Use qualifier guessed for a correct-but-guessed step and slip for a mere slip. confidence and self_signal are optional: fill them only if the student was asked or volunteered it; never invent them. Pass task_id instead of task to reuse a known question. If this question carried out a planned decision (e.g. a retest or practice), pass executes_decision_id to mark it done in the same call.',
    inputSchema: obj(
      {
        session_id: int('Session id'),
        task_id: int('Existing task id'),
        task: obj(
          {
            source: oneOf(TASK_SOURCES, 'Where the question came from'),
            source_ref: str('e.g. 2024 期末 第3题'),
            format: oneOf(FORMATS, 'Question format'),
            prompt: str('Question or a summary'),
            answer: str('Reference answer'),
            steps: {
              type: 'array',
              items: obj(
                { node_id: nodeId, role: oneOf(['core', 'supporting'], 'Default core'), description: str('What this step requires') },
                ['node_id'],
              ),
            },
          },
          ['source', 'steps'],
        ),
        context: oneOf(CONTEXTS, 'When/how it was answered. right_after_teaching = straight after the explanation or worked example; rule_baseline counts an unhinted success there only as assisted'),
        hints: oneOf(HINTS, 'How much help was given'),
        overall: oneOf(OVERALL, 'Overall result'),
        confidence: int('0–100, only if the student gave it'),
        self_signal: oneOf(SELF_SIGNALS, 'Only if the student said it'),
        seconds_spent: int('Time spent'),
        note: str('Note'),
        ...executesSchema,
        step_results: {
          type: 'array',
          description: 'One entry per task step',
          items: obj(
            {
              step_no: int('1-based step number'),
              outcome: oneOf(OUTCOMES, 'Result on this step'),
              qualifier: oneOf(QUALIFIERS, 'Optional'),
              difficulties: { type: 'array', items: oneOf(DIFFICULTIES, 'Learning difficulty'), description: 'Optional, multi-select' },
              interpretation: str('What rule the student actually applied here, if it differs from the intended one'),
              note: str('What happened'),
            },
            ['step_no', 'outcome'],
          ),
        },
      },
      ['context', 'hints', 'overall', 'step_results'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'context'), CONTEXTS, 'context');
      inEnum(need(a, 'hints'), HINTS, 'hints');
      inEnum(need(a, 'overall'), OVERALL, 'overall');
      inEnum(opt(a, 'self_signal'), SELF_SIGNALS, 'self_signal');
      const sessionId = opt<number>(a, 'session_id');
      if (sessionId) await mustExist(env, 'sessions', sessionId, 'session');
      const results = need<Json[]>(a, 'step_results');
      if (!results.length) throw new ToolError('step_results must list at least one step');
      const confidence = opt<number>(a, 'confidence');
      if (confidence !== null && (confidence < 0 || confidence > 100)) throw new ToolError('confidence must be 0–100');
      const seen = new Set<unknown>();
      for (const r of results) {
        if (seen.has(r.step_no)) throw new ToolError(`step ${r.step_no} appears twice in step_results`);
        seen.add(r.step_no);
        inEnum(r.outcome, OUTCOMES, 'outcome');
        inEnum(r.qualifier ?? null, QUALIFIERS, 'qualifier');
        for (const d of (r.difficulties as string[] | undefined) ?? []) inEnum(d, DIFFICULTIES, 'difficulty');
        if (r.difficulties && (r.difficulties as string[]).length && r.outcome !== 'failed' && r.outcome !== 'unclear')
          throw new ToolError(`step ${r.step_no}: difficulties only apply to failed or unclear steps`);
      }

      // Everything that can be rejected is checked before the first INSERT: a failed call must leave
      // no orphan task or attempt behind, since the model will simply call again.
      let taskId = opt<number>(a, 'task_id');
      const exec = opt<number>(a, 'executes_decision_id');
      const checkSteps = async (stepNos: number[], stepNodes: number[]) => {
        for (const r of results)
          if (!stepNos.includes(r.step_no as number)) throw new ToolError(`task ${taskId ?? '(new)'} has no step ${r.step_no}`);
        if (exec) await checkExecutable(env, exec, stepNodes);
      };
      if (!taskId) {
        const t = need<Json>(a, 'task');
        inEnum(t.source, TASK_SOURCES, 'task.source');
        inEnum(t.format ?? null, FORMATS, 'task.format');
        const steps = (t.steps as Json[]) ?? [];
        if (!steps.length) throw new ToolError('task.steps must list at least one step');
        for (const s of steps) {
          inEnum(s.role ?? null, ['core', 'supporting'], 'role');
          await mustExist(env, 'nodes', s.node_id as number, 'node');
        }
        await checkSteps(steps.map((_, i) => i + 1), steps.map((s) => s.node_id as number));
        taskId = await insertId(
          env,
          'INSERT INTO tasks (source, source_ref, format, prompt, answer) VALUES (?, ?, ?, ?, ?)',
          t.source,
          t.source_ref ?? null,
          t.format ?? null,
          t.prompt ?? null,
          t.answer ?? null,
        );
        await env.DB.batch(
          steps.map((s, i) =>
            env.DB.prepare('INSERT INTO task_steps (task_id, step_no, node_id, description, role) VALUES (?, ?, ?, ?, ?)').bind(
              taskId,
              i + 1,
              s.node_id,
              s.description ?? null,
              s.role ?? 'core',
            ),
          ),
        );
      } else {
        await mustExist(env, 'tasks', taskId, 'task');
      }

      const steps = await all<{ id: number; step_no: number; node_id: number }>(
        env,
        'SELECT id, step_no, node_id FROM task_steps WHERE task_id = ?',
        taskId,
      );
      const byNo = new Map(steps.map((s) => [s.step_no, s]));
      if (opt(a, 'task_id')) await checkSteps([...byNo.keys()], steps.map((s) => s.node_id));

      const attemptId = await insertId(
        env,
        `INSERT INTO attempts (task_id, session_id, context, hints, overall, confidence, self_signal, seconds_spent, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId,
        sessionId,
        a.context,
        a.hints,
        a.overall,
        confidence,
        opt(a, 'self_signal'),
        opt(a, 'seconds_spent'),
        opt(a, 'note'),
      );
      const evidenceIds: Record<number, number> = {};
      for (const r of results) {
        const step = byNo.get(r.step_no as number)!;
        const id = await insertId(
          env,
          `INSERT INTO evidence (node_id, attempt_id, step_id, session_id, kind, outcome, qualifier, interpretation, note)
           VALUES (?, ?, ?, ?, 'step', ?, ?, ?, ?)`,
          step.node_id,
          attemptId,
          step.id,
          sessionId,
          r.outcome,
          r.qualifier ?? null,
          r.interpretation ?? null,
          r.note ?? null,
        );
        evidenceIds[step.step_no] = id;
        const diffs = (r.difficulties as string[] | undefined) ?? [];
        if (diffs.length)
          await env.DB.batch(
            diffs.map((d) => env.DB.prepare('INSERT OR IGNORE INTO evidence_difficulties VALUES (?, ?)').bind(id, d)),
          );
      }
      const nodeIds = [...new Set(steps.map((s) => s.node_id))];
      const closed = exec ? await completeDecision(env, exec, sessionId, opt(a, 'decision_outcome')) : null;
      const open = await plannedFor(env, nodeIds);
      return {
        task_id: taskId,
        attempt_id: attemptId,
        evidence_ids_by_step: evidenceIds,
        ...(closed ? { closed_decision: closed } : {}),
        ...(open.length ? { open_decisions: open, hint: CLOSE_HINT } : {}),
      };
    },
  },
  {
    name: 'record_evidence',
    description:
      'Record evidence that is not a full answered question. exposure: the student was taught or read it; give representation (which way it was explained). prediction: a quick embedded check during teaching (predict, classify, judge an instance, give a counterexample); give outcome, representation and, above all, interpretation. self_explain: explained it in their own words; give outcome. self_report: student says they get it or not; weakest evidence. interpretation = what rule the student actually seems to be using, in particular a misreading (e.g. 以为边际分布相同就严格平稳). If this carried out a planned decision (e.g. the explanation an explain decision called for), pass executes_decision_id to mark it done in the same call.',
    inputSchema: obj(
      {
        node_id: nodeId,
        kind: oneOf(LIGHT_KINDS, 'Evidence kind'),
        session_id: int('Session id'),
        outcome: oneOf(OUTCOMES, 'For prediction and self_explain'),
        qualifier: oneOf(QUALIFIERS, 'Optional, e.g. guessed'),
        representation: oneOf(REPRESENTATIONS, 'How it was explained (exposure, prediction)'),
        interpretation: str('What the student took the rule to be'),
        difficulties: { type: 'array', items: oneOf(DIFFICULTIES, 'Learning difficulty') },
        note: str('What was observed'),
        ...executesSchema,
      },
      ['node_id', 'kind'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'kind'), LIGHT_KINDS, 'kind');
      inEnum(opt(a, 'outcome'), OUTCOMES, 'outcome');
      inEnum(opt(a, 'qualifier'), QUALIFIERS, 'qualifier');
      inEnum(opt(a, 'representation'), REPRESENTATIONS, 'representation');
      if (a.kind === 'prediction' && !opt(a, 'outcome')) throw new ToolError('prediction needs an outcome');
      await mustExist(env, 'nodes', need<number>(a, 'node_id'), 'node');
      const sessionId = opt<number>(a, 'session_id');
      if (sessionId) await mustExist(env, 'sessions', sessionId, 'session');
      const diffs = (a.difficulties as string[] | undefined) ?? [];
      for (const d of diffs) inEnum(d, DIFFICULTIES, 'difficulty');
      const exec = opt<number>(a, 'executes_decision_id');
      if (exec) await checkExecutable(env, exec, [a.node_id as number]);
      const id = await insertId(
        env,
        `INSERT INTO evidence (node_id, session_id, kind, outcome, qualifier, representation, interpretation, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        a.node_id,
        sessionId,
        a.kind,
        opt(a, 'outcome'),
        opt(a, 'qualifier'),
        opt(a, 'representation'),
        opt(a, 'interpretation'),
        opt(a, 'note'),
      );
      if (diffs.length)
        await env.DB.batch(diffs.map((d) => env.DB.prepare('INSERT OR IGNORE INTO evidence_difficulties VALUES (?, ?)').bind(id, d)));
      const closed = exec ? await completeDecision(env, exec, sessionId, opt(a, 'decision_outcome')) : null;
      const open = await plannedFor(env, [a.node_id as number]);
      const notice = a.kind === 'exposure' || a.kind === 'prediction' ? await chainNotice(env, a.node_id as number) : null;
      return {
        evidence_id: id,
        ...(notice ?? {}),
        ...(closed ? { closed_decision: closed } : {}),
        ...(open.length ? { open_decisions: open, hint: CLOSE_HINT } : {}),
      };
    },
  },
  {
    name: 'assess_state',
    description:
      'Write a new knowledge-state judgement for a node (appended; history is kept). level: unknown, exposed, assisted, independent, validated, weak, recheck. basis must list the evidence ids it rests on (from this node), except for unknown. Check get_node\'s rule_baseline first and explain in rationale when you deviate from it. Returns the node\'s still-planned decisions: review each against the new state and close, revoke or keep it.',
    inputSchema: obj(
      {
        node_id: nodeId,
        level: oneOf(LEVELS, 'Knowledge state'),
        basis: { type: 'array', items: { type: 'integer' }, description: 'Evidence ids' },
        rationale: str('Why this judgement'),
        weak_point: str('Where exactly it breaks down, if anywhere'),
        assessed_by: oneOf(['ai', 'rule', 'self'], 'Default ai'),
      },
      ['node_id', 'level', 'rationale'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'level'), LEVELS, 'level');
      inEnum(opt(a, 'assessed_by'), ['ai', 'rule', 'self'], 'assessed_by');
      const node = need<number>(a, 'node_id');
      await mustExist(env, 'nodes', node, 'node');
      const basis = ((a.basis as number[] | undefined) ?? []).map(Number);
      if (a.level !== 'unknown' && !basis.length) throw new ToolError('basis must list at least one evidence id');
      if (basis.length) {
        const found = await all<{ id: number }>(
          env,
          `SELECT id FROM evidence WHERE node_id = ? AND id IN (${basis.map(() => '?').join(',')})`,
          node,
          ...basis,
        );
        const missing = basis.filter((b) => !found.some((f) => f.id === b));
        if (missing.length) throw new ToolError(`evidence ${missing.join(', ')} does not belong to node ${node}`);
      }
      const id = await insertId(
        env,
        `INSERT INTO knowledge_states (node_id, level, weak_point, basis, rationale, assessed_by) VALUES (?, ?, ?, ?, ?, ?)`,
        node,
        a.level,
        opt(a, 'weak_point'),
        JSON.stringify(basis),
        need(a, 'rationale'),
        opt(a, 'assessed_by') ?? 'ai',
      );
      const open = await plannedFor(env, [node]);
      return open.length
        ? { state_id: id, open_decisions: open, hint: 'The state just changed. ' + CLOSE_HINT }
        : { state_id: id };
    },
  },
  {
    name: 'estimate_value',
    description:
      'Record a new estimate of how much a node matters for one assessment (0 not examined, 1 low, 2 medium, 3 high). Always give the basis and uncertainty. value may be null when there is no material. A value of 3 needs at least one source other than guess: never call something must-know without material.',
    inputSchema: obj(
      {
        node_id: nodeId,
        assessment_id: int('Assessment id'),
        value: { type: ['integer', 'null'], minimum: 0, maximum: 3, description: '0–3 or null' },
        uncertainty: oneOf(UNCERTAINTY, 'How sure the estimate is'),
        sources: { type: 'array', items: oneOf(VALUE_SOURCES, 'Source type') },
        basis: str('e.g. 近 3 年真题出现 2 次'),
      },
      ['node_id', 'assessment_id', 'uncertainty', 'basis'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'uncertainty'), UNCERTAINTY, 'uncertainty');
      const sources = (a.sources as string[] | undefined) ?? [];
      for (const s of sources) inEnum(s, VALUE_SOURCES, 'source');
      const value = a.value === undefined ? null : (a.value as number | null);
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 3)) throw new ToolError('value must be 0–3 or null');
      if (value === 3 && !sources.some((s) => s !== 'guess'))
        throw new ToolError('value 3 needs at least one real source (syllabus, past_paper, teacher, homework or textbook)');
      await mustExist(env, 'nodes', need<number>(a, 'node_id'), 'node');
      await mustExist(env, 'assessments', need<number>(a, 'assessment_id'), 'assessment');
      const id = await insertId(
        env,
        'INSERT INTO node_values (node_id, assessment_id, value, uncertainty, sources, basis) VALUES (?, ?, ?, ?, ?, ?)',
        a.node_id,
        a.assessment_id,
        value,
        a.uncertainty,
        JSON.stringify(sources),
        need(a, 'basis'),
      );
      return { value_id: id };
    },
  },
  {
    name: 'decide',
    description:
      'Record a teaching decision. One-off actions (diagnose, explain, practice, retest, advance) start as planned. Scope decisions (learn, skim, skip) start active and replace the previous active scope decision for the same node and assessment, which is marked revoked. Always give the reason; give condition when it only holds for a while (e.g. 仅限期中前).',
    inputSchema: obj(
      {
        action: oneOf(ACTIONS, 'Action'),
        reason: str('Why'),
        node_id: int('Node id (omit for a course-level decision)'),
        course_id: int('Course id for a course-level decision'),
        assessment_id: int('Assessment this decision serves'),
        state_id: int('Knowledge state it is based on'),
        condition: str('When it stops applying'),
        priority: int('1 highest – 3 lowest'),
      },
      ['action', 'reason'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'action'), ACTIONS, 'action');
      const node = opt<number>(a, 'node_id');
      if (node) await mustExist(env, 'nodes', node, 'node');
      for (const [key, table, label] of [['course_id', 'courses', 'course'], ['assessment_id', 'assessments', 'assessment'], ['state_id', 'knowledge_states', 'state']]) {
        const ref = opt<number>(a, key);
        if (ref) await mustExist(env, table, ref, label);
      }
      const pr = opt<number>(a, 'priority');
      if (pr !== null && (pr < 1 || pr > 3)) throw new ToolError('priority must be 1–3');
      const scope = SCOPE_ACTIONS.includes(a.action as string);
      const id = await insertId(
        env,
        `INSERT INTO decisions (node_id, course_id, state_id, assessment_id, action, reason, condition, priority, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        node,
        opt(a, 'course_id'),
        opt(a, 'state_id'),
        opt(a, 'assessment_id'),
        a.action,
        need(a, 'reason'),
        opt(a, 'condition'),
        pr,
        scope ? 'active' : 'planned',
      );
      let replaced = 0;
      if (scope && node) {
        const r = await env.DB.prepare(
          `UPDATE decisions SET status = 'revoked', revoked_at = datetime('now'),
             revoked_why = 'replaced by decision ' || ?, superseded_by = ?
           WHERE node_id = ? AND status = 'active' AND action IN ('learn','skim','skip') AND id <> ?
             AND assessment_id IS ?`,
        )
          .bind(id, id, node, id, opt(a, 'assessment_id'))
          .run();
        replaced = r.meta.changes;
      }
      const notice = node && a.action === 'explain' ? await chainNotice(env, node) : null;
      return { decision_id: id, status: scope ? 'active' : 'planned', replaced, ...(notice ?? {}) };
    },
  },
  {
    name: 'update_decision',
    description: 'Close a decision: done (with outcome) or revoked (with revoked_why, e.g. new evidence or the exam changed).',
    inputSchema: obj(
      {
        decision_id: int('Decision id'),
        status: oneOf(['done', 'revoked'], 'New status'),
        outcome: str('What happened after acting on it'),
        revoked_why: str('Why it no longer holds'),
        superseded_by: int('Decision that replaces it'),
        done_session: int('Session it was carried out in'),
      },
      ['decision_id', 'status'],
    ),
    run: async (env, a) => {
      inEnum(need(a, 'status'), ['done', 'revoked'], 'status');
      await mustExist(env, 'decisions', need<number>(a, 'decision_id'), 'decision');
      if (a.status === 'revoked' && !opt(a, 'revoked_why')) throw new ToolError('revoked_why is required when revoking');
      const superseded = opt<number>(a, 'superseded_by');
      if (superseded) await mustExist(env, 'decisions', superseded, 'decision');
      const doneSession = opt<number>(a, 'done_session');
      if (doneSession) await mustExist(env, 'sessions', doneSession, 'session');
      await env.DB.prepare(
        `UPDATE decisions SET status = ?, outcome = COALESCE(?, outcome),
           revoked_at = CASE WHEN ? = 'revoked' THEN datetime('now') ELSE revoked_at END,
           revoked_why = COALESCE(?, revoked_why), superseded_by = COALESCE(?, superseded_by),
           done_session = COALESCE(?, done_session)
         WHERE id = ?`,
      )
        .bind(a.status, opt(a, 'outcome'), a.status, opt(a, 'revoked_why'), opt(a, 'superseded_by'), opt(a, 'done_session'), a.decision_id)
        .run();
      return { ok: true };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export function hasTool(name: string): boolean {
  return TOOL_MAP.has(name);
}

export async function callTool(env: Env, name: string, args: unknown): Promise<unknown> {
  const tool = TOOL_MAP.get(name)!;
  return tool.run(env, conform(tool.inputSchema, args ?? {}, '') as Json);
}
