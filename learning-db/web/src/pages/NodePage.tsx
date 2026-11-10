import { Breadcrumb, BreadcrumbItem } from "@/components/base/breadcrumb/breadcrumb";
import { Chip } from "@/components/base/badges/chip";
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from "@/components/base/table/table";
import { useApi, type NodeDetail, type EvidenceRow } from "@/lib/api";
import {
  ACTION,
  ASSESSED_BY,
  CONTEXT,
  DECISION_STATUS,
  DIFFICULTY,
  EVIDENCE_KIND,
  HINTS,
  KIND,
  LAYER_LABEL,
  LEVEL,
  OUTCOME,
  QUALIFIER,
  RELATION,
  REPRESENTATION,
  SELF_SIGNAL,
  TASK_SOURCE,
  UNCERTAINTY,
  VALUE_LABEL,
  WEIGHT,
  fmtTime,
} from "@/lib/labels";
import { MathText } from "@/components/math-text";
import { href } from "@/lib/router";
import { Card, CardTitle, Empty, ErrorCard, Field, LevelChip, Loading, PageHeader, ValuePips } from "@/components/ui";
import { cx } from "@/utils/cx";
import { LEVEL_BAR } from "./Overview";

export function NodePage({ id }: { id: number }) {
  const { data, error, loading } = useApi<NodeDetail>(`/nodes/${id}`);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorCard error={error!} />;
  const { node, current_state: cs, rule_baseline: rb } = data;
  const facts = [
    ["用途与用法", node.usage],
    ["直觉", node.intuition],
    ["定义", node.definition],
    ["适用条件 / 反例", node.boundary],
    ["常见易错点", node.pitfalls],
  ].filter(([, v]) => v) as [string, string][];
  const relations = [
    ...data.edges.incoming.map((e) => ({ ...e, label: RELATION[e.relation]?.in ?? e.relation })),
    ...data.edges.outgoing.map((e) => ({ ...e, label: RELATION[e.relation]?.out ?? e.relation })),
  ];

  return (
    <>
      <Breadcrumb className="mb-3">
        <BreadcrumbItem href={href.overview}>知识库</BreadcrumbItem>
        <BreadcrumbItem href={href.course(node.course_id)}>{node.course}</BreadcrumbItem>
        <BreadcrumbItem current>
          <MathText>{node.title}</MathText>
        </BreadcrumbItem>
      </Breadcrumb>
      <PageHeader
        title={<MathText>{node.title}</MathText>}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <span>{KIND[node.kind] ?? node.kind}</span>
            <LevelChip level={cs.level} />
            {rb && rb.suggested_level !== cs.level ? (
              <span className="text-caption-1-regular text-text-tertiary">
                规则基线：{LEVEL[rb.suggested_level].label}
              </span>
            ) : null}
          </span>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardTitle>知识内容</CardTitle>
            {facts.length ? (
              <dl className="flex flex-col gap-4">
                {facts.map(([k, v]) => (
                  <Field key={k} label={k}>
                    <MathText>{v}</MathText>
                  </Field>
                ))}
              </dl>
            ) : (
              <Empty>还没有写入定义、直觉或易错点</Empty>
            )}
          </Card>

          <Card>
            <CardTitle extra={<span className="text-caption-1-regular text-text-tertiary">最近 {data.evidence.length} 条</span>}>
              学习证据
            </CardTitle>
            {data.evidence.length ? (
              <ol className="flex flex-col gap-4">
                {data.evidence.map((e) => (
                  <EvidenceItem key={e.id} e={e} />
                ))}
              </ol>
            ) : (
              <Empty>还没有证据</Empty>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardTitle>状态变化</CardTitle>
            {cs.level === "unknown" && !data.state_history.length ? (
              <Empty>还没有评估过</Empty>
            ) : (
              <ol className="flex flex-col">
                {data.state_history.map((s, i) => (
                  <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < data.state_history.length - 1 ? (
                      <span className="absolute start-[5px] top-4 bottom-0 w-px bg-separator-border" aria-hidden />
                    ) : null}
                    <span className={cx("mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-background-primary-default", LEVEL_BAR[s.level])} />
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-body-medium text-text-primary">{LEVEL[s.level].label}</span>
                        <span className="text-caption-1-regular text-text-tertiary">
                          {fmtTime(s.assessed_at)} · {ASSESSED_BY[s.assessed_by]}判断
                        </span>
                      </div>
                      {s.weak_point ? <span className="text-caption-1-regular text-status-rose-text">卡在：<MathText>{s.weak_point}</MathText></span> : null}
                      {s.rationale ? <p className="text-body-2-regular text-text-secondary"><MathText>{s.rationale}</MathText></p> : null}
                      <span className="text-caption-2-regular text-text-tertiary">依据证据 {fmtBasis(s.basis)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {data.representations_tried?.length ? (
            <Card>
              <CardTitle>试过的讲法</CardTitle>
              <ul className="flex flex-col gap-2">
                {data.representations_tried.map((r) => (
                  <li key={r.representation} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-body-2-medium text-text-primary">
                      {REPRESENTATION[r.representation] ?? r.representation}
                    </span>
                    <span className="text-caption-1-regular text-text-secondary">用过 {r.times_used} 次</span>
                    {r.failed_checks ? (
                      <Chip variant="caption" color="rose">
                        检查失败 {r.failed_checks}
                      </Chip>
                    ) : null}
                    <span className="ms-auto text-caption-1-regular text-text-tertiary">{fmtTime(r.last_used, false)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardTitle>考核价值</CardTitle>
            {data.values.length ? (
              <Table aria-label="考核价值" size="sm">
                <TableHeader>
                  <TableColumn isRowHeader>考核</TableColumn>
                  <TableColumn>价值</TableColumn>
                  <TableColumn>依据</TableColumn>
                </TableHeader>
                <TableBody>
                  {data.values.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell>{v.assessment}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2 whitespace-nowrap">
                          <ValuePips value={v.value} uncertainty={v.uncertainty} />
                          {v.value === null ? "未知" : VALUE_LABEL[v.value]}
                          <span className="text-text-tertiary">{UNCERTAINTY[v.uncertainty]}</span>
                        </span>
                      </TableCell>
                      <TableCell><MathText>{v.basis}</MathText></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>没有资料，不估价值</Empty>
            )}
          </Card>

          <Card>
            <CardTitle>教学决策</CardTitle>
            {data.decisions.length ? (
              <ul className="flex flex-col gap-3">
                {data.decisions.map((d) => {
                  const a = ACTION[d.action] ?? { label: d.action, color: "neutral" as const };
                  const closed = d.status === "done" || d.status === "revoked";
                  return (
                    <li key={d.id} className={cx("flex gap-3", closed && "opacity-60")}>
                      <Chip variant="caption" color={a.color} className="h-fit">
                        {a.label}
                      </Chip>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className={cx("text-body-2-regular text-text-primary", d.status === "revoked" && "line-through")}>
                          <MathText>{d.reason}</MathText>
                        </span>
                        <span className="text-caption-1-regular text-text-tertiary">
                          {DECISION_STATUS[d.status]} · {fmtTime(d.decided_at, false)}
                          {d.stale && d.status === "planned" ? <StaleBadge /> : null}
                          {d.condition ? ` · 条件：${d.condition}` : ""}
                        </span>
                        {d.revoked_why ? (
                          <span className="text-caption-1-regular text-text-tertiary">撤销原因：<MathText>{d.revoked_why}</MathText></span>
                        ) : null}
                        {d.outcome ? <span className="text-caption-1-regular text-text-secondary">效果：<MathText>{d.outcome}</MathText></span> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>还没有决策</Empty>
            )}
          </Card>

          <Card>
            <CardTitle>相关知识点</CardTitle>
            {relations.length ? (
              <ul className="flex flex-col gap-1">
                {relations.map((r) => (
                  <li key={`${r.relation}-${r.node_id}-${r.label}`}>
                    <a
                      href={href.node(r.node_id)}
                      className="-mx-2 flex items-center gap-2 rounded-xl px-2 py-1.5 outline-none hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                    >
                      <span className="w-20 shrink-0 text-caption-1-medium text-text-tertiary">{r.label}</span>
                      <span className="text-body-2-medium text-text-primary"><MathText>{r.title}</MathText></span>
                      {r.relation === "prerequisite_of" && r.weight ? (
                        <Chip variant="caption" color={r.weight === 3 ? "orange" : "neutral"}>
                          {WEIGHT[r.weight]}
                          {r.needed_layer ? ` · ${LAYER_LABEL[r.needed_layer]}` : ""}
                        </Chip>
                      ) : null}
                      {r.course_id !== undefined && r.course_id !== node.course_id ? (
                        <span className="shrink-0 text-caption-1-regular text-text-tertiary">{r.course}</span>
                      ) : null}
                      {r.note ? <span className="truncate text-caption-1-regular text-text-tertiary"><MathText>{r.note}</MathText></span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>没有记录关系</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function StaleBadge() {
  return (
    <Chip variant="caption" color="yellow" className="ms-1.5" title="做出这条决策后，这个知识点的状态又被重新评估过">
      可能已过时
    </Chip>
  );
}

function fmtBasis(basis: string) {
  try {
    const ids = JSON.parse(basis) as number[];
    return ids.map((i) => `#${i}`).join("、");
  } catch {
    return basis;
  }
}

function EvidenceItem({ e }: { e: EvidenceRow }) {
  const o = e.outcome ? OUTCOME[e.outcome] : null;
  const meta = [
    e.context ? CONTEXT[e.context] : null,
    e.hints ? HINTS[e.hints] : null,
    e.self_signal ? SELF_SIGNAL[e.self_signal] : null,
    e.confidence !== null ? `自估把握 ${e.confidence}%` : null,
  ].filter(Boolean);
  return (
    <li className="flex flex-col gap-1.5 border-s-2 border-separator-border ps-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-caption-1-medium text-text-tertiary">#{e.id}</span>
        <span className="text-body-2-medium text-text-primary">{EVIDENCE_KIND[e.kind] ?? e.kind}</span>
        {o ? (
          <Chip variant="caption" color={o.color}>
            {o.label}
          </Chip>
        ) : null}
        {e.qualifier ? (
          <Chip variant="caption" color="purple" title="不计入掌握或缺口">
            {QUALIFIER[e.qualifier]}
          </Chip>
        ) : null}
        {e.representation ? (
          <Chip variant="caption" color="cyan" title="讲解方式">
            {REPRESENTATION[e.representation] ?? e.representation}
          </Chip>
        ) : null}
        {e.difficulties.map((d) => (
          <Chip key={d} variant="caption" color="orange">
            {DIFFICULTY[d] ?? d}
          </Chip>
        ))}
        <span className="ms-auto text-caption-1-regular text-text-tertiary">{fmtTime(e.observed_at)}</span>
      </div>
      {e.task_prompt || e.source_ref ? (
        <p className="text-body-2-regular text-text-secondary">
          {e.task_source ? `${TASK_SOURCE[e.task_source] ?? e.task_source} · ` : ""}
          {e.source_ref ? `${e.source_ref} · ` : ""}
          <MathText>{e.task_prompt}</MathText>
          {e.step_no ? `（第 ${e.step_no} 步${e.role === "supporting" ? "，辅助" : ""}` : ""}
          {e.step_no && e.step_description ? <>：<MathText>{e.step_description}</MathText></> : null}
          {e.step_no ? "）" : ""}
        </p>
      ) : null}
      {meta.length ? <span className="text-caption-1-regular text-text-tertiary">{meta.join(" · ")}</span> : null}
      {e.interpretation ? (
        <p className="text-body-2-regular text-status-orange-text">实际用的规则：<MathText>{e.interpretation}</MathText></p>
      ) : null}
      {e.note ? <p className="text-body-2-regular text-text-primary"><MathText>{e.note}</MathText></p> : null}
    </li>
  );
}
