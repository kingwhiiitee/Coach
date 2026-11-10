# AGENTS.md

给在这个仓库里干活的 agent 看的。README 写给人；这里只写改代码前必须知道、但从代码里不容易看出来的事。

仓库原名 `BetterAI`，2026-11 改名 `Coach`；precise-edit 已拆到独立仓库 `kingwhiiitee/precise-edit`，这里不再有它的代码。

## 仓库里有什么

| 目录 | 内容 | 运行环境 |
| --- | --- | --- |
| `plugins/adaptive-learning-coach/` | 学习教练技能（只有 `SKILL.md`，中文） | — |
| `Latex Fix/` | ChatGPT 公式修复：userscript、转换页、CLI、技能（目录名带空格，命令里记得加引号） | 浏览器 / Node |
| `scripts/` | `build.mjs` 打包 `dist/` | Node ≥ 18，零依赖 |
| `tests/` | `node --test`，覆盖 LaTeX 核心 | Node |
| `learning-db/` | 学习知识库：Cloudflare Worker（MCP + 只读 API）+ D1 + 阅览网页 | Workers / D1 |
| `learning-db/web/` | 阅览网页源码（React 19 + Tailwind v4 + BoardUI），构建到 `learning-db/public/` | Vite |

## 常用命令

```bash
# 仓库根目录：CI 在 Linux/macOS/Windows × Node 20/22/24 上跑这两条
npm test
node scripts/build.mjs

# learning-db/
npm ci && npm run typecheck
npm run build:web                      # 改了 web/ 之后必须跑，并提交 public/
echo 'ACCESS_TOKEN="test-token-0123456789abcdef"' > .dev.vars
npm run db:init:local && npm run dev   # 另开终端：
BASE=http://127.0.0.1:8787 TOKEN=test-token-0123456789abcdef npm run e2e
```

`npm run e2e` 会写数据，只能对着本地全新的库跑，绝不要指向线上 Worker。

CI 的 `learning-db` job（ubuntu）会跑 typecheck、重新构建 `web/` 并要求 `public/` 没有差异、再对本地 D1 跑 e2e。改了 Worker 行为就在 `scripts/e2e.mjs` 里加一条检查。

## 必须遵守的约定

**提交**：直接提交并推送到 `main`，不开 PR。推送前跑上面对应的检查。可能有其他 agent 同时在改，推送前先 `git pull --rebase`。

**根目录的脚本和插件零依赖**：`scripts/`、`plugins/`、`Latex Fix/`、`tests/` 只能用 Node 内置模块，并且要在 Windows 上也能跑（路径用 `path`，别假设 `/`）。`build.mjs` 产物要字节可复现：不要引入时间戳、随机数或机器相关内容。

**新增技能**：放在 `plugins/<name>/skills/<name>/SKILL.md` + `plugins/<name>/.claude-plugin/plugin.json`，在 `.claude-plugin/marketplace.json` 注册，在 `scripts/build.mjs` 加一行 `pack(...)`。改技能内容时同时升 `plugin.json` 和 `marketplace.json` 里的版本号。

**LaTeX Fix 核心不能碰 DOM**：userscript 里的 `LatexFix` 核心会被 `node:vm`（CLI、测试）和转换页加载。`build.mjs` 会按原样匹配 `converter.html` 里的 `<script src="../userscript/chatgpt-latex-fix.user.js"></script>` 并把 userscript 内联进去，所以那一行不能改，userscript 里也不能出现 `</script`。文件开头的 `// ==UserScript==` 头是脚本管理器要读的，不是普通注释。`@name` / `@namespace` 里的 `BetterAI`、`betterai-math` 类名和 `betterai-latex-fix.format` 这个 localStorage 键是旧名，故意保留：改了脚本管理器会当成另一个脚本，用户已存的设置也会丢。

## learning-db

**部署顺序：先迁移 D1，再部署 Worker。**

```bash
npx wrangler d1 execute learning-knowledge --remote --file migrations/<file>.sql
npx wrangler deploy
```

- `schema.sql` 只用来建新库（`db:init:local`）。改表结构要同时改 `schema.sql` 并新增一个 `migrations/NNNN-*.sql`；迁移要兼容旧版 Worker（新列给默认值或可空），因为迁移和部署之间旧代码仍在跑。SQLite 改不了已有的 `CHECK`，要改枚举只能重建表（参考 `migrations/0003`）。
- `tools.ts` 里的枚举数组与 `schema.sql` 的 `CHECK` 一一对应，改一边必须改另一边。
- AI 永远不直接写 SQL：所有读写都通过 `src/worker/tools.ts` 里固定的 MCP 工具。`/api/*` 只读，网页不允许写。
- 工具的 `inputSchema` 不只是给模型看的说明：`callTool` 会按它校验并转换参数（数字字符串转成整数，schema 里没列的参数名直接报错）。新增参数必须写进 schema，否则调用会被拒绝。
- `record_attempt` / `record_evidence` 要在第一条 INSERT 之前做完所有校验：调用失败后模型会重试，中途失败会留下重复的题目、作答或证据。
- 外键都没有 `ON DELETE`，删除级联由 `delete_record` 在一个 D1 batch 里手工完成。新增表或外键时要把它加进 `deletionPlan`。
- `knowledge_states` 和 `node_values` 只追加不修改，最新一行就是当前值。`knowledge_states.basis` 是证据 id 的 JSON 数组，没有外键约束。
- `prerequisite_of` 必须保持无环，`link_nodes` 在写入时检查。
- 工具描述、`index.ts` 的 `INSTRUCTIONS`（每个 MCP 客户端初始化时都会收到）和 `plugins/adaptive-learning-coach` 的 `SKILL.md` 说的是同一套流程，改行为时三处一起对齐。
- `web/src/lib/api.ts` 里的类型是照 `tools.ts` 的返回结构手抄的，改返回结构要同步。
- `wrangler.jsonc` 的 `run_worker_first` 要包含 Worker 处理的所有路径，否则会被静态资源（SPA fallback）挡住。
- D1 的时间是不带时区的 UTC `YYYY-MM-DD HH:MM:SS`。

**阅览网页**：`learning-db/public/` 是 `npm run build:web` 的产物，已提交，不要手改；改 `web/` 后重新构建并一起提交。写 UI 前先读 `learning-db/web/AGENTS.md`（BoardUI 规则：只用语义 token、组合字体工具类、`cx()` 合并类名）。`web/src/components/base|application|foundations` 和 `styles/` 来自 BoardUI，优先用 BoardUI 重新安装而不是手改。

## 注释

只写下一个 agent 读代码时自己看不出来的东西：意图、不变量、坑、跨文件的约束。不要写复述代码的注释、分节标题或改动历史。功能性的注释要保留：`// ==UserScript==` 头、`@ts-` / lint 指令、Markdown 里的 `<!-- boardui:rules -->` 标记。
