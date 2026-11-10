// Routes: /mcp and /mcp/<token> = MCP over Streamable HTTP (JSON responses only, no SSE);
// /api/* = read-only JSON for the viewer; everything else = static assets from ./public.
// wrangler.jsonc run_worker_first must list every route handled here, or assets will shadow it.
//
import { TOOLS, ToolError, callTool, hasTool, overview, courseTree, nodeDetail, type Env } from './tools';

const SERVER_INFO = { name: 'learning-knowledge', version: '0.3.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Sent to every MCP client on initialize; clients use it as their operating manual for the tools.
// Keep it in sync with the tool descriptions in tools.ts and with the adaptive-learning-coach SKILL.md.
const INSTRUCTIONS = `个人学习知识库（Evidence-Centered Design 四层：知识节点 / 学习证据 / 知识状态 / 教学决策）。
开课先调 overview 看上次的中断点和待办决策，再用 review_candidates 或 get_node 决定本轮任务；start_session 返回 unfinished_sessions 时先用 end_session 补上收尾，返回考核目标提示时问学生一次考试时间和题型并用 upsert_assessment 记下（不知道也建一条，不再追问）；
讲解新知识点前先调 prerequisite_chain 建好前置知识链（可跨课程、跨学科；link_nodes 写权重 1–3 和所需层，梳理完用 upsert_node 标 prereqs_reviewed），按 teach_order 先诊断或补缺口；
作答后用 record_attempt 按步骤记录证据（做错只记真正出错的那一步）；
需要时用 assess_state 写状态（必须引用证据 id），用 decide 记录下一步；结束用 end_session 写微型学习记录。
学生从零起步（没学过、必需前置多为缺口）时放慢：用自述代替诊断题，先看 2 个已解例题再做逐步撤除提示的题，本轮做到有提示能完成即可，独立检验留到下一轮；紧跟讲解后做对只算 assisted。
自估把握只在学生说了或被问到时填写，不要编造。`;

const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, env: Env, pathToken: string | null): boolean {
  if (!env.ACCESS_TOKEN || env.ACCESS_TOKEN.length < 16) return false;  // fail closed: a missing or short secret must never mean "open"
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const token = bearer ?? pathToken;
  return token !== null && timingSafeEqual(token, env.ACCESS_TOKEN);
}

type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };

async function handleRpc(env: Env, msg: RpcRequest): Promise<unknown | null> {
  const isNotification = msg?.id === undefined || msg.id === null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });

  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (isNotification) return null;

  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive },
        })),
      });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (!hasTool(name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(env, name, msg.params?.arguments);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError: false });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `internal error: ${(e as Error).message}`;
        return ok({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET') return new Response('SSE stream not supported; POST JSON-RPC instead', { status: 405, headers: { allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcRequest[];
  const replies = (await Promise.all(messages.map((m) => handleRpc(env, m)))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}

// Read-only by design: the viewer must never write. All writes go through MCP tools.
async function handleApi(url: URL, env: Env): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean);
  const id = /^\d+$/.test(parts[2] ?? '') ? Number(parts[2]) : null;
  try {
    if (parts[1] === 'overview' && parts.length === 2) return json(await overview(env, null));
    if (parts[1] === 'courses' && parts.length === 3 && id !== null) return json(await courseTree(env, id));
    if (parts[1] === 'nodes' && parts.length === 3 && id !== null) return json(await nodeDetail(env, id));
    return json({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof ToolError) return json({ error: e.message }, 404);
    throw e;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const pathToken = path.startsWith('/mcp/') ? decodeURIComponent(path.slice(5)) : null;
      if (!authorized(req, env, pathToken))
        return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
      return handleMcp(req, env);
    }

    if (path.startsWith('/api/')) {
      if (req.method !== 'GET') return json({ error: 'read-only' }, 405);
      if (!authorized(req, env, null)) return json({ error: 'unauthorized' }, 401);
      return handleApi(url, env);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
