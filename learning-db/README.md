# learning-knowledge：个人学习知识库

给 [adaptive-learning-coach](../plugins/adaptive-learning-coach/skills/adaptive-learning-coach/SKILL.md) 用的跨会话记忆。一个 Cloudflare Worker 同时提供：

- `/mcp`：给 AI 用的 MCP 接口（19 个固定工具，AI 不直接写 SQL）
- `/api/*`：给阅览网页用的只读 JSON
- `/`：阅览网页（BoardUI，源码在 [web/](web)，构建产物在 `public/`）

数据存在 Cloudflare D1（`learning-knowledge`），表结构见 [schema.sql](schema.sql)。

## 数据模型

按 Evidence-Centered Design 分四层：

| 层 | 表 | 说明 |
| --- | --- | --- |
| 知识节点 | `courses` `nodes` `edges` `assessments` `node_values` `tasks` `task_steps` | 知识本身；考核价值按"节点 × 考核目标"估计，带依据和不确定性；前置关系带权重，可跨课程、跨学科 |
| 学习证据 | `sessions` `attempts` `evidence` `evidence_difficulties` | 一道题拆成步骤，每步落到一个节点；做错只记真正出错的那一步 |
| 知识状态 | `knowledge_states` | 七种状态：unknown / exposed / assisted / independent / validated / weak / recheck；只追加，必须引用证据 |
| 教学决策 | `decisions` | 讲解、练习、复测、推进，以及可撤销的学 / 略读 / 跳过 |

### 前置关系与跨学科

- **权重** `edges.weight`：3 必需 · 2 重要 · 1 辅助。决定前置需要达到的水平（3 → independent，2 → assisted，1 → exposed）。
- **所需层** `edges.needed_layer`：后续知识讲到哪一层（use / mechanism / principle / boundary）才用到这个前置；为空表示任何层都需要。
- **跨学科**：`courses.subject` 记学科；`courses.kind = foundation` 是跨课程共享的学科基础库（如"线性代数基础"）。关系可以连接任意两门课程的节点；`analogous_to` 记不同学科间结构相同、可作类比的知识。
- `prerequisite_chain` 沿前置关系向上（跨课程）走，给出每个前置的路径权重、所需水平、当前状态（ok / gap / unverified）和补救顺序；`nodes.prereqs_reviewed_at` 记这条链是否已梳理完。前置关系不允许成环。

视图：`current_state`（每个节点的最新状态）、`rule_baseline`（只看证据的机械建议，供 AI 参考：最近一步做错是 weak，之后检查做对是 assisted；独立完成满 30 天、已验证满 60 天没有新证据是 recheck）、`current_values`、`open_decisions`。

## MCP 工具

| 读 | 写 |
| --- | --- |
| `overview` `find_nodes` `get_node` `prerequisite_chain` `review_candidates` | `upsert_course` `upsert_assessment` `upsert_node` `link_nodes` `move_node` `start_session` `end_session` `record_attempt` `record_evidence` `assess_state` `estimate_value` `decide` `update_decision` `delete_record` |

工具层强制几条规则：状态必须引用本节点的证据；没有真实资料不能把考核价值标为 3；新的学 / 略读 / 跳过决定会自动撤销旧决定；撤销决定必须写原因；自估把握只在提供时记录。`start_session` 会列出没写总结的旧会话，提醒先补上收尾；课程没有考核目标时，`upsert_course` / `start_session` 会提醒问一次考试信息。参数按各工具的 schema 校验：数字字符串会转成整数，写错的参数名会报错并列出可用的名字；一次调用要么全部写入，要么在写入前被拒绝。

`delete_record` 用来删掉建错或重复的记录（课程、节点、考核目标、题目、学习会话、作答、证据、状态、决策、考核价值）。不带 `confirm` 调用只预览、不删除，列出会连带删掉的所有内容（例如删节点会带走它的关系、证据、状态、考核价值、决策，以及每一步都只考这个节点的题目）；学生同意后带 `confirm=true` 再调一次，所有删除在一个事务里完成。剩下的状态如果引用了被删的证据，会提示重新评估。改判断不靠删除：状态用新的 `assess_state` 覆盖，决策用 `update_decision` 撤销。

## 部署

```bash
cd learning-db
npm install
npx wrangler login                      # 或设置 CLOUDFLARE_API_TOKEN
npx wrangler secret put ACCESS_TOKEN    # 输入一个 16 位以上的随机字符串
npx wrangler deploy
```

D1 数据库已经存在，`wrangler.jsonc` 里的 `database_id` 指向它。表结构升级脚本在 [migrations/](migrations)，对已有库按编号执行（`npx wrangler d1 execute learning-knowledge --remote --file migrations/<文件>`）；新列都有默认值，先迁移数据库再部署 Worker 不会影响旧版。全新数据库需要先执行 `npx wrangler d1 execute learning-knowledge --remote --file schema.sql`。

没有设置 `ACCESS_TOKEN`（或少于 16 位）时，`/mcp` 和 `/api` 一律返回 401。

## 连接到 AI

- **Claude.ai**：设置 → 连接器 → 添加自定义连接器，URL 填 `https://<worker 域名>/mcp/<ACCESS_TOKEN>`。令牌在 URL 里，不要把这个地址分享出去。
- **Claude Code**：`claude mcp add --transport http learning-knowledge https://<worker 域名>/mcp --header "Authorization: Bearer <ACCESS_TOKEN>"`

## 阅览网页

打开 Worker 域名，输入 `ACCESS_TOKEN` 即可（令牌只存在本机浏览器）。页面：

- **仪表盘**（默认首页）：待执行的下一步决策、最近的学习记录
- **知识库**：每门课的七种状态分布、考核目标和倒计时
- **课程页（知识地图）**：知识点按前置关系分层连线（线条粗细表示前置权重），可按状态筛选、搜索；考核价值用三个点表示，可切换考核目标；下方列出来自其他课程、学科的前置与类比
- **知识点详情**：定义 / 直觉 / 适用条件 / 易错点，状态变化及理由，学习证据时间线，考核价值依据，教学决策，相关知识点
- **待办决策**：待执行的讲解、练习、复测，以及生效中的学 / 略读 / 跳过

文字里的 LaTeX 公式（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`）由本地打包的 KaTeX 渲染，不依赖外部 CDN。

网页是 React + Tailwind v4 + [BoardUI](https://www.boardui.com) 组件，用 Vite 构建到 `public/`。构建结果已提交，`wrangler deploy` 前不需要再构建；改了 `web/` 之后运行 `npm run build:web`。

## 本地开发

```bash
echo 'ACCESS_TOKEN="test-token-0123456789abcdef"' > .dev.vars
npm run db:init:local
npm run dev
# 另开一个终端，用一个全新的本地库运行端到端检查
BASE=http://127.0.0.1:8787 TOKEN=test-token-0123456789abcdef npm run e2e
# 改网页：再开一个终端，Vite 会把 /api 代理到 8787
npm run dev:web
```
