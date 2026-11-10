// Needs `npm run dev` on a fresh local DB (npm run db:init:local) and a .dev.vars ACCESS_TOKEN:
//   BASE=http://127.0.0.1:8787 TOKEN=... npm run e2e
// It writes data, so never point it at the deployed Worker.
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TOKEN;
let id = 0;
async function rpc(method, params, token = TOKEN, path = '/mcp') {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}
async function call(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  const text = body.result.content[0].text;
  if (body.result.isError) return { error: text };
  return JSON.parse(text);
}
function check(cond, msg) {
  if (!cond) { console.error('FAIL', msg); process.exitCode = 1; } else console.log('ok  ', msg);
}

check((await rpc('tools/list', {}, null)).status === 401, 'no token → 401');
check((await rpc('tools/list', {}, 'wrong-token-wrong-token')).status === 401, 'wrong token → 401');
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
check(init.body.result.serverInfo.name === 'learning-knowledge', 'initialize');
check((await rpc('tools/list', {}, null, '/mcp/' + TOKEN)).status === 200, 'token in path works');
const n = await fetch(BASE + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
check(n.status === 202, 'notification → 202');
const tools = (await rpc('tools/list', {})).body.result.tools;
check(tools.length >= 15, `tools/list returns ${tools.length} tools`);

const { course_id } = await call('upsert_course', { name: '深度学习' });
const { assessment_id } = await call('upsert_assessment', { course_id, name: '期末', exam_date: '2026-12-20' });
const ids = {};
for (const [title, kind] of [['前向传播', 'method'], ['激活函数导数', 'formula'], ['链式法则', 'theorem'], ['误差反传', 'method'], ['矩阵维度', 'concept']])
  ids[title] = (await call('upsert_node', { course_id, title, kind })).node_id;
check(Object.values(ids).every(Boolean), 'nodes created');
check((await call('upsert_node', { course_id, title: '链式法则', kind: 'theorem', definition: 'd(f∘g)=f\'(g)g\'' })).node_id === ids['链式法则'], 'upsert_node updates in place');
await call('upsert_node', { course_id, title: '链式法则', kind: 'theorem', usage: '复合函数求导时用' });
const un = await call('get_node', { node_id: ids['链式法则'] });
check(un.node.usage === '复合函数求导时用' && un.node.definition, 'usage stored without wiping other facts');
await call('link_nodes', { from_id: ids['链式法则'], to_id: ids['误差反传'], relation: 'prerequisite_of' });

const v3 = await call('estimate_value', { node_id: ids['链式法则'], assessment_id, value: 3, uncertainty: 'high', basis: '感觉重要', sources: ['guess'] });
check(!!v3.error, 'value 3 from guess only is rejected');
await call('estimate_value', { node_id: ids['链式法则'], assessment_id, value: 3, uncertainty: 'medium', basis: '大纲重点', sources: ['syllabus'] });

const { session_id } = await call('start_session', { course_id, planned_min: 20, goal: '应考' });
const att = await call('record_attempt', {
  session_id,
  task: { source: 'past_paper', format: 'calculation', prompt: '双层网络参数梯度', steps: [
    { node_id: ids['前向传播'], role: 'supporting' }, { node_id: ids['激活函数导数'], role: 'supporting' },
    { node_id: ids['链式法则'] }, { node_id: ids['误差反传'] }, { node_id: ids['矩阵维度'], role: 'supporting' } ] },
  context: 'delayed', hints: 'none', overall: 'wrong',
  step_results: [
    { step_no: 1, outcome: 'demonstrated' }, { step_no: 2, outcome: 'demonstrated', qualifier: 'guessed' },
    { step_no: 3, outcome: 'failed', difficulties: ['condition', 'recognition'] },
    { step_no: 4, outcome: 'not_reached' }, { step_no: 5, outcome: 'not_reached' } ],
});
check(att.attempt_id && Object.keys(att.evidence_ids_by_step).length === 5, 'record_attempt writes 5 evidence rows');
const bad = await call('record_attempt', { task_id: att.task_id, context: 'delayed', hints: 'none', overall: 'wrong', step_results: [{ step_no: 9, outcome: 'failed' }] });
check(!!bad.error, 'unknown step rejected');

const node = await call('get_node', { node_id: ids['链式法则'] });
check(node.rule_baseline.suggested_level === 'weak', 'rule baseline: failed step → weak');
check(node.evidence[0].difficulties.length === 2, 'difficulties are multi-select');
const act = await call('get_node', { node_id: ids['激活函数导数'] });
check(act.rule_baseline.suggested_level === 'exposed', 'guessed correct is not counted as mastery');
const fwd = await call('get_node', { node_id: ids['前向传播'] });
check(fwd.rule_baseline.suggested_level === 'independent', 'demonstrated without hints → independent');
check((await call('get_node', { node_id: ids['误差反传'] })).rule_baseline.suggested_level === 'exposed', 'not_reached gives no mastery evidence');

check(!!(await call('assess_state', { node_id: ids['链式法则'], level: 'weak', rationale: 'x' })).error, 'state without evidence rejected');
check(!!(await call('assess_state', { node_id: ids['链式法则'], level: 'weak', rationale: 'x', basis: [att.evidence_ids_by_step[1]] })).error, 'evidence from another node rejected');
const st = await call('assess_state', { node_id: ids['链式法则'], level: 'weak', weak_point: '复合函数条件', rationale: '真题第3步错', basis: [att.evidence_ids_by_step[3]] });
check(st.state_id, 'assess_state ok');

const d1 = await call('decide', { node_id: ids['矩阵维度'], assessment_id, action: 'skim', reason: '低价值', condition: '仅限期末前' });
const d2 = await call('decide', { node_id: ids['矩阵维度'], assessment_id, action: 'learn', reason: '后续课程需要' });
check(d1.status === 'active' && d2.replaced === 1, 'new scope decision revokes the previous one');
const d3 = await call('decide', { node_id: ids['链式法则'], assessment_id, action: 'explain', reason: '条件理解错', priority: 1, state_id: st.state_id });
check(d3.status === 'planned', 'one-off decision is planned');
check(!!(await call('update_decision', { decision_id: d3.decision_id, status: 'revoked' })).error, 'revoke needs a reason');
await call('end_session', { session_id, summary: '链式法则条件不清；下次从复合函数求导开始' });
await call('record_evidence', { node_id: ids['链式法则'], kind: 'exposure', representation: 'verbal', session_id });
check(!!(await call('record_evidence', { node_id: ids['链式法则'], kind: 'prediction', representation: 'verbal' })).error, 'prediction without outcome rejected');
await call('record_evidence', { node_id: ids['链式法则'], kind: 'prediction', representation: 'verbal', outcome: 'failed', interpretation: '以为外层导数不用代入内层函数' });
const pn = await call('get_node', { node_id: ids['链式法则'] });
check(pn.representations_tried[0]?.representation === 'verbal' && pn.representations_tried[0].failed_checks === 1, 'representations_tried counts failed checks per representation');
check(pn.evidence[0].interpretation?.includes('外层'), 'interpretation is stored');

const cand = await call('review_candidates', { course_id, assessment_id });
check(cand[0]?.title === '链式法则', 'review_candidates ranks weak high-value node first');
const ov = await call('overview', {});
check(ov.courses[0].levels.weak === 1 && ov.open_decisions.length === 2 && ov.last_sessions[0].summary, 'overview shows states, decisions, last session');
check(ov.open_decisions[0].status === 'planned' && ov.open_decisions[0].course === '深度学习' && ov.last_sessions[0].course === '深度学习', 'overview lists planned decisions first, with course names');
check((await call('review_candidates', { course_id }))[0]?.exam_value === 3, 'review_candidates defaults to the upcoming assessment');

check((await call('get_node', { node_id: String(ids['链式法则']) })).node?.title === '链式法则', 'numeric string ids are coerced');
check((await call('upsert_node', { course_id, titel: '拼错', kind: 'concept' })).error?.includes('unknown argument'), 'unknown argument names are rejected');
check((await call('decide', { node_id: ids['链式法则'], assessment_id: 999999, action: 'practice', reason: 'x' })).error?.includes('not found'), 'decide checks referenced ids');
const okStep = { context: 'delayed', hints: 'none', overall: 'correct', step_results: [{ step_no: 1, outcome: 'demonstrated' }] };
const newTask = { source: 'ai_generated', steps: [{ node_id: ids['前向传播'] }] };
const before = await call('record_attempt', { task: newTask, ...okStep });
check(!!(await call('record_attempt', { task: newTask, ...okStep, step_results: [{ step_no: 2, outcome: 'failed' }] })).error, 'unknown step on a new task rejected');
check(!!(await call('record_attempt', { task: newTask, ...okStep, executes_decision_id: d1.decision_id })).error, 'attempt cannot execute a decision that is not planned');
check(!!(await call('record_attempt', { task: newTask, ...okStep, confidence: 150 })).error, 'confidence out of range rejected');
const after = await call('record_attempt', { task: newTask, ...okStep });
check(after.task_id === before.task_id + 1 && after.attempt_id === before.attempt_id + 1, 'rejected attempts leave no task or attempt behind');
check((await fetch(BASE + '/api/courses/abc', { headers: { authorization: `Bearer ${TOKEN}` } })).status === 404, 'web API: non-numeric id → 404');

const api = await fetch(BASE + `/api/courses/${course_id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
const tree = await api.json();
check(api.status === 200 && tree.nodes.length === 5 && tree.edges.length === 1, 'web API course tree');
check((await fetch(BASE + '/api/overview')).status === 401, 'web API needs token');

const ex = await call('record_evidence', { node_id: ids['链式法则'], kind: 'exposure', representation: 'graph', session_id, executes_decision_id: d3.decision_id, decision_outcome: '用计算图重讲' });
check(ex.closed_decision === d3.decision_id, 'executes_decision_id closes the decision in the same call');
check(!!(await call('record_evidence', { node_id: ids['前向传播'], kind: 'exposure', executes_decision_id: d3.decision_id })).error, 'cannot close an already-done decision');
const d4 = await call('decide', { node_id: ids['链式法则'], assessment_id, action: 'retest', reason: '隔天复测', priority: 2 });
check(!!(await call('record_evidence', { node_id: ids['前向传播'], kind: 'exposure', executes_decision_id: d4.decision_id })).error, 'cannot close a decision about another node');
await new Promise((r) => setTimeout(r, 1100));
const pe = await call('record_evidence', { node_id: ids['链式法则'], kind: 'prediction', outcome: 'demonstrated', representation: 'graph', session_id });
check(pe.open_decisions?.some((d) => d.id === d4.decision_id), 'recording evidence lists open decisions on the node');
const st2 = await call('assess_state', { node_id: ids['链式法则'], level: 'assisted', rationale: '图示后能判断', basis: [pe.evidence_id] });
check(st2.open_decisions?.length === 1 && st2.hint, 'assess_state lists planned decisions to review');
check((await call('get_node', { node_id: ids['链式法则'] })).rule_baseline.suggested_level === 'assisted', 'rule baseline: failed step followed by a passed check → assisted');
const ov2 = await call('overview', {});
check(ov2.open_decisions.find((d) => d.id === d4.decision_id)?.stale === 1, 'overview flags the decision as stale after a newer state');
const es = await call('end_session', { session_id, summary: '第二段' });
check(es.unclosed_decisions?.[0]?.id === d4.decision_id, 'end_session reports unclosed decisions on studied nodes');
await call('update_decision', { decision_id: d4.decision_id, status: 'done', outcome: '复测通过' });
check(!(await call('end_session', { session_id, summary: '第二段' })).unclosed_decisions, 'nothing reported once closed');

const { course_id: math } = await call('upsert_course', { name: '微积分基础', subject: '数学', kind: 'foundation' });
check((await call('overview', { course_id: math })).courses[0].kind === 'foundation', 'foundation course stored');
const deriv = (await call('upsert_node', { course_id: math, title: '导数', kind: 'concept', prereqs_reviewed: true })).node_id;
const compose = (await call('upsert_node', { course_id: math, title: '复合函数', kind: 'concept' })).node_id;
check(!!(await call('get_node', { node_id: deriv })).node.prereqs_reviewed_at, 'new node can be marked reviewed in the same call');
check((await call('link_nodes', { from_id: deriv, to_id: ids['链式法则'], relation: 'prerequisite_of', weight: 2, note: '链式法则是导数的运算规则' })).cross_course, 'cross-course prerequisite link');
await call('link_nodes', { from_id: compose, to_id: ids['链式法则'], relation: 'prerequisite_of', weight: 3 });
await call('link_nodes', { from_id: ids['链式法则'], to_id: ids['误差反传'], relation: 'prerequisite_of', weight: 3 });
await call('link_nodes', { from_id: deriv, to_id: compose, relation: 'prerequisite_of', weight: 1, needed_layer: 'principle' });
await call('link_nodes', { from_id: ids['矩阵维度'], to_id: ids['误差反传'], relation: 'prerequisite_of', weight: 2, needed_layer: 'mechanism' });
check(!!(await call('link_nodes', { from_id: ids['误差反传'], to_id: deriv, relation: 'prerequisite_of' })).error, 'prerequisite cycle rejected');
check(!!(await call('link_nodes', { from_id: deriv, to_id: compose, relation: 'contrasts_with', weight: 3 })).error, 'weight only on prerequisites');
check(!!(await call('link_nodes', { from_id: deriv, to_id: ids['前向传播'], relation: 'analogous_to', note: 'x' })).ok, 'analogous_to relation accepted');

const ch = await call('prerequisite_chain', { node_id: ids['误差反传'] });
const byId = Object.fromEntries(ch.prerequisites.map((p) => [p.node_id, p]));
check(byId[ids['链式法则']]?.depth === 1 && byId[deriv]?.depth >= 2 && byId[deriv].cross_course, 'chain walks upstream across courses');
check(byId[deriv].path_weight === 2, 'path weight is the weakest link on the strongest path');
check(byId[ids['链式法则']].status === 'gap', 'assisted prerequisite of weight 3 is a gap');
check(ch.teach_order[0].node_id === deriv, 'teach order is deepest first');
check(!ch.ready && ch.hint.includes('prereqs_reviewed=true'), 'unreviewed target gets a build-the-chain hint');
const chUse = await call('prerequisite_chain', { node_id: ids['误差反传'], layer: 'use' });
check(!chUse.prerequisites.some((p) => p.node_id === ids['矩阵维度']), 'layer filter drops prerequisites only needed deeper');
const chHeavy = await call('prerequisite_chain', { node_id: ids['链式法则'], min_weight: 3 });
check(chHeavy.prerequisites.length === 1, 'min_weight filters light links');
const nd = await call('get_node', { node_id: ids['链式法则'] });
check(nd.edges.incoming.some((e) => e.course === '微积分基础' && e.weight === 3), 'get_node shows link weight and course of the other node');
const exp = await call('record_evidence', { node_id: ids['误差反传'], kind: 'exposure', representation: 'verbal' });
check(exp.prerequisite_chain && !exp.prerequisite_chain.reviewed, 'explaining an unreviewed node returns a chain notice');
await call('upsert_node', { course_id, title: '误差反传', kind: 'method', prereqs_reviewed: true });
const dx = await call('decide', { node_id: ids['误差反传'], action: 'explain', reason: '新内容' });
check(!dx.prerequisite_chain || dx.prerequisite_chain.reviewed, 'notice reflects the reviewed mark');
const tree2 = await (await fetch(BASE + `/api/courses/${course_id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
check(tree2.external_nodes.some((n) => n.id === deriv) && tree2.edges.some((e) => e.from_id === deriv), 'course tree includes cross-course links');
const found = await call('find_nodes', { subject: '数学' });
check(found.length === 2 && found[0].course === '微积分基础', 'find_nodes filters by subject');
const { course_id: la } = await call('upsert_course', { name: '线性代数基础', subject: '数学', kind: 'foundation' });
await call('move_node', { node_id: ids['矩阵维度'], course_id: la });
check((await call('get_node', { node_id: ids['矩阵维度'] })).node.course === '线性代数基础', 'move_node moves a node to another course');

const { course_id: tmp } = await call('upsert_course', { name: '临时课程', subject: '测试' });
const { assessment_id: tmpExam } = await call('upsert_assessment', { course_id: tmp, name: '期中' });
const dupA = (await call('upsert_node', { course_id: tmp, title: '重复节点', kind: 'concept' })).node_id;
const keepB = (await call('upsert_node', { course_id: tmp, title: '保留节点', kind: 'concept' })).node_id;
await call('link_nodes', { from_id: dupA, to_id: keepB, relation: 'prerequisite_of', weight: 2 });
await call('link_nodes', { from_id: deriv, to_id: dupA, relation: 'prerequisite_of', weight: 1 });
await call('estimate_value', { node_id: dupA, assessment_id: tmpExam, value: 2, uncertainty: 'medium', basis: '作业', sources: ['homework'] });
const { session_id: tmpS } = await call('start_session', { course_id: tmp });
const soloTask = await call('record_attempt', {
  session_id: tmpS, task: { source: 'ai_generated', prompt: '只考重复节点', steps: [{ node_id: dupA }] },
  context: 'right_after_teaching', hints: 'none', overall: 'correct', step_results: [{ step_no: 1, outcome: 'demonstrated' }],
});
const mixed = await call('record_attempt', {
  session_id: tmpS, task: { source: 'ai_generated', prompt: '两个节点', steps: [{ node_id: dupA }, { node_id: keepB }] },
  context: 'right_after_teaching', hints: 'none', overall: 'wrong',
  step_results: [{ step_no: 1, outcome: 'failed', difficulties: ['execution'] }, { step_no: 2, outcome: 'demonstrated' }],
});
check((await call('get_node', { node_id: keepB })).rule_baseline.suggested_level === 'assisted', 'unhinted success right after teaching → assisted, not independent');
const ebs = mixed.evidence_ids_by_step;
const evOf = (n) => (Array.isArray(ebs) ? ebs[n - 1] : ebs[n]);
await call('assess_state', { node_id: dupA, level: 'weak', rationale: '第一步错', basis: [evOf(1)] });
await call('assess_state', { node_id: keepB, level: 'independent', rationale: '第二步对', basis: [evOf(2)] });
await call('decide', { node_id: dupA, action: 'practice', reason: '再练' });
await call('decide', { node_id: dupA, action: 'skim', reason: '期中略读', assessment_id: tmpExam });

const pv = await call('delete_record', { target: 'node', id: dupA });
check(pv.preview && pv.will_delete.nodes === 1 && pv.will_delete.edges === 2 && pv.will_delete.tasks === 1, 'delete preview counts node, links and its solo question');
check((await call('get_node', { node_id: dupA })).node, 'preview deletes nothing');
const dn = await call('delete_record', { target: 'node', id: dupA, confirm: true });
check(dn.deleted && dn.deleted_row.title === '重复节点', 'node deleted on confirm');
check(!!(await call('get_node', { node_id: dupA })).error, 'deleted node is gone');
const kb = await call('get_node', { node_id: keepB });
check(kb.node && kb.edges.incoming.length === 0, 'other node keeps its record but loses the link');
check(!(await call('get_node', { node_id: deriv })).edges.outgoing.some((e) => e.node_id === dupA), 'cross-course link removed');
check(!!(await call('delete_record', { target: 'node', id: 999999 })).error, 'unknown id rejected');

const ps = await call('delete_record', { target: 'session', id: tmpS });
check(ps.preview && ps.states_citing_deleted_evidence?.some((k) => k.node_id === keepB), 'session preview warns about states citing its evidence');
const pc = await call('delete_record', { target: 'course', id: tmp });
check(pc.will_delete.courses === 1 && pc.will_delete.nodes === 1 && pc.will_delete.sessions === 1 && pc.will_delete.assessments === 1, 'course preview lists nodes, sessions, assessments');
check((await call('delete_record', { target: 'course', id: tmp, confirm: true })).deleted, 'course deleted with everything in it');
check(!(await call('overview', {})).courses.some((c) => c.id === tmp), 'course gone from overview');
void soloTask;

const nc = await call('upsert_course', { name: '新课程', subject: '测试' });
check(nc.hint?.includes('upsert_assessment'), 'new course without an assessment gets an ask-once hint');
check(!(await call('upsert_course', { name: '新课程' })).hint && !(await call('upsert_course', { name: '新基础', kind: 'foundation' })).hint, 'no hint on update or for foundation courses');
const s1 = await call('start_session', { course_id: nc.course_id });
check(s1.hint?.includes('upsert_assessment'), 'start_session repeats the hint while the course has no assessment');
await call('upsert_assessment', { course_id: nc.course_id, name: '期末考试', scope_note: '学生暂不清楚' });
const s2 = await call('start_session', { course_id: nc.course_id });
check(s2.unfinished_sessions?.some((s) => s.id === s1.session_id) && !s2.hint.includes('upsert_assessment'), 'start_session lists sessions that never got a summary');
await call('end_session', { session_id: s1.session_id, summary: '中断，未记录' });
await call('end_session', { session_id: s2.session_id, summary: 'x' });
check(!(await call('start_session', {})).unfinished_sessions, 'nothing listed once they are closed');
