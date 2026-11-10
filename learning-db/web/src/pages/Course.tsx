import { useMemo, useState } from "react";
import type { Key } from "react-aria-components";
import { Breadcrumb, BreadcrumbItem } from "@/components/base/breadcrumb/breadcrumb";
import { Chip } from "@/components/base/badges/chip";
import { SearchField } from "@/components/base/search-field/search-field";
import { SegmentedControl, SegmentedControlItem } from "@/components/base/segmented-control/segmented-control";
import { useApi, type CourseTree, type Level, type TreeNode, type ValueRow, type ScopeDecision } from "@/lib/api";
import { ACTION, KIND, LEVEL, LEVELS, WEIGHT, daysUntil } from "@/lib/labels";
import { MathText } from "@/components/math-text";
import { href } from "@/lib/router";
import { Card, CardTitle, Empty, ErrorCard, LevelChip, Loading, PageHeader, ValuePips } from "@/components/ui";
import { cx } from "@/utils/cx";
import { LEVEL_BAR } from "./Overview";

interface Ctx {
  values: Map<number, ValueRow>;
  scope: Map<number, ScopeDecision>;
  prereqCount: Map<number, number>;
}

export function CoursePage({ id }: { id: number }) {
  const { data, error, loading } = useApi<CourseTree>(`/courses/${id}`);
  const [assessment, setAssessment] = useState<Key | null>(null);
  const [query, setQuery] = useState("");

  const activeAssessment = assessment ?? data?.assessments.find((a) => a.status === "upcoming")?.id ?? data?.assessments[0]?.id ?? null;

  const ctx = useMemo<Ctx>(() => {
    const aid = activeAssessment === null ? null : Number(activeAssessment);
    const values = new Map<number, ValueRow>();
    const scope = new Map<number, ScopeDecision>();
    const prereqCount = new Map<number, number>();
    for (const v of data?.values ?? []) if (v.assessment_id === aid) values.set(v.node_id, v);
    for (const s of data?.scope_decisions ?? [])
      if (s.assessment_id === aid || s.assessment_id === null) scope.set(s.node_id, s);
    for (const e of data?.edges ?? [])
      if (e.relation === "prerequisite_of") prereqCount.set(e.to_id, (prereqCount.get(e.to_id) ?? 0) + 1);
    return { values, scope, prereqCount };
  }, [data, activeAssessment]);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorCard error={error!} />;

  const current = data.assessments.find((a) => a.id === Number(activeAssessment));
  const days = current ? daysUntil(current.exam_date) : null;

  return (
    <>
      <Breadcrumb className="mb-3">
        <BreadcrumbItem href={href.overview}>知识库</BreadcrumbItem>
        <BreadcrumbItem current>{data.course.name}</BreadcrumbItem>
      </Breadcrumb>
      <PageHeader
        title={data.course.name}
        sub={
          <>
            {data.nodes.length} 个知识点
            {current ? ` · 考核目标：${current.name}${days !== null && days >= 0 ? `（还有 ${days} 天）` : ""}` : ""}
          </>
        }
        extra={
          data.assessments.length > 1 ? (
            <SegmentedControl
              aria-label="考核目标"
              selectedKeys={activeAssessment !== null ? [activeAssessment] : []}
              onSelectionChange={(keys) => {
                const k = [...keys][0];
                if (k !== undefined) setAssessment(k);
              }}
            >
              {data.assessments.map((a) => (
                <SegmentedControlItem key={a.id} id={a.id}>
                  {a.name}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          ) : null
        }
      />

      {current && (current.exam_format || current.scope_note) ? (
        <Card className="mb-4 flex flex-col gap-1 py-4">
          {current.exam_format ? (
            <p className="text-body-2-regular text-text-secondary">
              <span className="text-text-tertiary">题型：</span>
              {current.exam_format}
            </p>
          ) : null}
          {current.scope_note ? (
            <p className="text-body-2-regular text-text-secondary">
              <span className="text-text-tertiary">范围：</span>
              {current.scope_note}
            </p>
          ) : null}
        </Card>
      ) : null}

      <KnowledgeMap data={data} ctx={ctx} query={query} setQuery={setQuery} />
      <ExternalPrereqs data={data} />
    </>
  );
}

const MASTERED: Level[] = ["independent", "validated"];

function NodeCard({ node: n, ctx, dim, ready }: { node: TreeNode; ctx: Ctx; dim?: boolean; ready?: boolean }) {
  const v = ctx.values.get(n.id);
  const s = ctx.scope.get(n.id);
  const drift = n.suggested_level !== n.level && n.suggested_level !== "unknown";
  return (
    <a
      href={href.node(n.id)}
      title={n.weak_point ? `卡在：${n.weak_point}` : undefined}
      className={cx(
        "relative flex h-full flex-col justify-center gap-1.5 overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default py-2.5 ps-4 pe-3 outline-none transition-[opacity,border-color]",
        "hover:border-border-button-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        s?.action === "skip" && "opacity-60",
        dim && "opacity-25",
      )}
    >
      <span aria-hidden className={cx("absolute inset-y-0 start-0 w-1", LEVEL_BAR[n.level])} />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body-medium text-text-primary"><MathText>{n.title}</MathText></span>
        <ValuePips value={v?.value ?? null} uncertainty={v?.uncertainty} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <LevelChip level={n.level} size="sm" />
        {ready ? (
          <Chip variant="caption" color="lime" title="前置都已独立掌握，可以开始学">
            可以学
          </Chip>
        ) : null}
        {s ? (
          <Chip variant="caption" color={ACTION[s.action].color} title={s.reason}>
            {ACTION[s.action].label}
          </Chip>
        ) : null}
        <span className="truncate text-caption-1-regular text-text-tertiary">
          {KIND[n.kind] ?? n.kind}
          {drift ? ` · 证据提示「${LEVEL[n.suggested_level as Level].label}」` : ""}
        </span>
      </div>
    </a>
  );
}

const COL_W = 208;
const COL_GAP = 40;
const ROW_H = 72;
const ROW_GAP = 12;
const levelRank = (l: Level) => LEVELS.indexOf(l);

function KnowledgeMap({
  data,
  ctx,
  query,
  setQuery,
}: {
  data: CourseTree;
  ctx: Ctx;
  query: string;
  setQuery: (q: string) => void;
}) {
  const nodes = data.nodes;
  const [levelFilter, setLevelFilter] = useState<Level | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const layout = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const pre = data.edges.filter((e) => e.relation === "prerequisite_of" && ids.has(e.from_id) && ids.has(e.to_id));
    const parents = new Map<number, number[]>();
    const children = new Map<number, number[]>();
    for (const e of pre) {
      parents.set(e.to_id, [...(parents.get(e.to_id) ?? []), e.from_id]);
      children.set(e.from_id, [...(children.get(e.from_id) ?? []), e.to_id]);
    }
    const depth = new Map<number, number>();
    const visiting = new Set<number>();
    const dfs = (id: number): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (visiting.has(id)) return 0; // link_nodes keeps the graph acyclic; this only guards bad data
      visiting.add(id);
      const d = Math.max(-1, ...(parents.get(id) ?? []).map(dfs)) + 1;
      visiting.delete(id);
      depth.set(id, d);
      return d;
    };
    nodes.forEach((n) => dfs(n.id));
    const cols: TreeNode[][] = [];
    for (const n of nodes) (cols[depth.get(n.id)!] ??= []).push(n);
    // Start each column clustered by state, then a few barycenter sweeps (down via parents, up via children) to cut crossings.
    const row = new Map<number, number>();
    const place = () => cols.forEach((col) => col.forEach((n, r) => row.set(n.id, r)));
    for (const col of cols)
      col.sort((a, b) => levelRank(a.level) - levelRank(b.level) || (ctx.values.get(b.id)?.value ?? -1) - (ctx.values.get(a.id)?.value ?? -1));
    place();
    const sweep = (col: TreeNode[], next: Map<number, number[]>) => {
      const key = new Map(
        col.map((n, i) => {
          const rs = (next.get(n.id) ?? []).map((k) => row.get(k) ?? 0);
          return [n.id, rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : i];
        }),
      );
      col.sort((a, b) => key.get(a.id)! - key.get(b.id)!);
      col.forEach((n, r) => row.set(n.id, r));
    };
    for (let i = 0; i < 4; i++) {
      for (let c = 1; c < cols.length; c++) sweep(cols[c], parents);
      for (let c = cols.length - 2; c >= 0; c--) sweep(cols[c], children);
    }
    const pos = new Map<number, { x: number; y: number }>();
    cols.forEach((col, c) => col.forEach((n, r) => pos.set(n.id, { x: c * (COL_W + COL_GAP), y: r * (ROW_H + ROW_GAP) })));
    const width = cols.length * (COL_W + COL_GAP) - COL_GAP;
    const height = Math.max(0, ...cols.map((c) => c.length)) * (ROW_H + ROW_GAP) - ROW_GAP;
    // "Ready" must count prerequisites in other courses too; `parents` only holds the in-course ones drawn on the map.
    const levelOf = new Map<number, Level>([...nodes, ...(data.external_nodes ?? [])].map((n) => [n.id, n.level]));
    const allParents = new Map<number, number[]>();
    for (const e of data.edges)
      if (e.relation === "prerequisite_of") allParents.set(e.to_id, [...(allParents.get(e.to_id) ?? []), e.from_id]);
    const ready = new Set(
      nodes
        .filter((n) => !MASTERED.includes(n.level) && allParents.has(n.id))
        .filter((n) => allParents.get(n.id)!.every((p) => MASTERED.includes(levelOf.get(p) ?? "unknown")))
        .map((n) => n.id),
    );
    return { cols, pos, pre, parents, children, width, height, ready };
  }, [nodes, data.edges, data.external_nodes, ctx]);

  // Focusing a node lights up everything it depends on and everything that depends on it.
  const chain = useMemo(() => {
    if (focus === null) return null;
    const out = new Set<number>([focus]);
    const walk = (id: number, next: Map<number, number[]>) => {
      for (const k of next.get(id) ?? []) if (!out.has(k)) { out.add(k); walk(k, next); }
    };
    walk(focus, layout.parents);
    walk(focus, layout.children);
    return out;
  }, [focus, layout]);

  const q = query.trim().toLowerCase();
  const matches = (n: TreeNode) =>
    (!levelFilter || n.level === levelFilter) &&
    (!q || n.title.toLowerCase().includes(q) || (n.definition ?? "").toLowerCase().includes(q));
  const lit = (n: TreeNode) => (chain ? chain.has(n.id) : matches(n));
  const counts = LEVELS.map((l) => ({ level: l, count: nodes.filter((n) => n.level === l).length })).filter((c) => c.count);
  const total = Math.max(nodes.length, 1);

  return (
    <Card className="p-0">
      <div className="flex flex-col gap-4 border-b border-separator-border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-headline-semibold text-text-primary">知识地图</h2>
          <SearchField
            aria-label="搜索知识点"
            placeholder="搜索知识点"
            size="small"
            value={query}
            onChange={setQuery}
            clearLabel="清除"
            className="w-full sm:w-56"
          />
        </div>
        {nodes.length ? (
          <div className="flex flex-col gap-3">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-background-tertiary-default">
              {counts.map((c) => (
                <span
                  key={c.level}
                  className={cx("h-full transition-opacity", LEVEL_BAR[c.level], levelFilter && levelFilter !== c.level && "opacity-25")}
                  style={{ width: `${(c.count / total) * 100}%` }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="按状态筛选">
              {counts.map((c) => {
                const on = levelFilter === c.level;
                return (
                  <button
                    key={c.level}
                    type="button"
                    aria-pressed={on}
                    title={LEVEL[c.level].hint}
                    onClick={() => setLevelFilter(on ? null : c.level)}
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption-1-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                      on
                        ? "border-border-button-hover bg-background-secondary-default text-text-primary"
                        : "border-border-button-default text-text-secondary hover:bg-background-secondary-default",
                    )}
                  >
                    <span className={cx("size-2 rounded-full", LEVEL_BAR[c.level])} />
                    {LEVEL[c.level].label}
                    <span className="text-text-tertiary">{c.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {!nodes.length ? (
        <Empty>还没有知识点</Empty>
      ) : layout.pre.length === 0 ? (
        <div className="flex flex-col gap-3 p-5">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {layout.cols[0].map((n) => (
              <div key={n.id} style={{ height: ROW_H }}>
                <NodeCard node={n} ctx={ctx} dim={!lit(n)} ready={layout.ready.has(n.id)} />
              </div>
            ))}
          </div>
          <p className="text-caption-1-regular text-text-tertiary">还没有记录前置关系，AI 用 link_nodes 建立后会按前置顺序分层连线。</p>
        </div>
      ) : (
        <div className="overflow-x-auto p-5">
          <div className="mb-3 flex" style={{ width: layout.width }}>
            {layout.cols.map((_, c) => (
              <span
                key={c}
                className="text-caption-1-medium text-text-tertiary"
                style={{ width: COL_W, marginInlineEnd: c < layout.cols.length - 1 ? COL_GAP : 0 }}
              >
                {c === 0 ? "基础（无前置）" : `第 ${c + 1} 层`}
              </span>
            ))}
          </div>
          <div className="relative" style={{ width: layout.width, height: layout.height }} dir="ltr">
            <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
              {layout.pre.map((e) => {
                const a = layout.pos.get(e.from_id)!;
                const b = layout.pos.get(e.to_id)!;
                const x1 = a.x + COL_W, y1 = a.y + ROW_H / 2, x2 = b.x, y2 = b.y + ROW_H / 2;
                const mx = (x1 + x2) / 2;
                const on = chain ? chain.has(e.from_id) && chain.has(e.to_id) : true;
                return (
                  <path
                    key={`${e.from_id}-${e.to_id}`}
                    d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    className={cx(
                      "fill-none transition-opacity",
                      chain && on ? "stroke-accent-500" : "stroke-foreground-icon-quaternary",
                      !on && "opacity-20",
                    )}
                    strokeWidth={e.weight === 3 ? 2.5 : e.weight === 1 ? 1 : 1.5}
                    strokeDasharray={e.weight === 1 ? "4 4" : undefined}
                  />
                );
              })}
            </svg>
            {nodes.map((n) => {
              const p = layout.pos.get(n.id)!;
              return (
                <div
                  key={n.id}
                  className="absolute"
                  style={{ left: p.x, top: p.y, width: COL_W, height: ROW_H }}
                  onMouseEnter={() => setFocus(n.id)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(n.id)}
                  onBlur={() => setFocus(null)}
                >
                  <NodeCard node={n} ctx={ctx} dim={!lit(n)} ready={layout.ready.has(n.id)} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function ExternalPrereqs({ data }: { data: CourseTree }) {
  const ext = new Map((data.external_nodes ?? []).map((n) => [n.id, n]));
  const local = new Map(data.nodes.map((n) => [n.id, n]));
  const links = data.edges
    .filter((e) => (e.relation === "prerequisite_of" || e.relation === "analogous_to") && (ext.has(e.from_id) || ext.has(e.to_id)))
    .map((e) => ({ e, other: ext.get(e.from_id) ?? ext.get(e.to_id)!, mine: local.get(ext.has(e.from_id) ? e.to_id : e.from_id) }));
  if (!links.length) return null;
  return (
    <Card className="mt-4">
      <CardTitle>跨课程 / 跨学科链接</CardTitle>
      <ul className="flex flex-col gap-1">
        {links.map(({ e, other, mine }) => (
          <li key={`${e.from_id}-${e.to_id}-${e.relation}`} className="flex flex-wrap items-center gap-2 py-1 text-body-2-regular">
            <a href={href.node(other.id)} className="text-body-2-medium text-text-primary hover:underline">
              <MathText>{other.title}</MathText>
            </a>
            <span className="text-caption-1-regular text-text-tertiary">
              {other.course}
              {other.subject ? ` · ${other.subject}` : ""}
            </span>
            <LevelChip level={other.level} />
            <span className="text-caption-1-regular text-text-tertiary">
              {e.relation === "analogous_to"
                ? "类比"
                : ext.has(e.from_id)
                  ? `→ ${WEIGHT[e.weight ?? 2]}前置于`
                  : "← 以本课为前置"}
            </span>
            {mine ? (
              <a href={href.node(mine.id)} className="text-body-2-medium text-text-primary hover:underline">
                <MathText>{mine.title}</MathText>
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
