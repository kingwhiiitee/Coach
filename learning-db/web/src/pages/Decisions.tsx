import { Chip } from "@/components/base/badges/chip";
import { useApi, type OpenDecision, type Overview } from "@/lib/api";
import { ACTION, DECISION_STATUS, fmtTime } from "@/lib/labels";
import { MathText } from "@/components/math-text";
import { href } from "@/lib/router";
import { Card, Empty, ErrorCard, Loading, PageHeader, ValuePips } from "@/components/ui";
import { cx } from "@/utils/cx";

export function DecisionsPage() {
  const { data, error, loading } = useApi<Overview>("/overview");
  if (loading) return <Loading />;
  if (error || !data) return <ErrorCard error={error!} />;
  const planned = data.open_decisions.filter((d) => d.status === "planned");
  const active = data.open_decisions.filter((d) => d.status === "active");
  return (
    <>
      <PageHeader title="待办决策" />
      <div className="flex flex-col gap-4">
        <Card>
          <h2 className="mb-3 text-headline-semibold text-text-primary">待执行 · {planned.length}</h2>
          <DecisionList decisions={planned} />
        </Card>
        <Card>
          <h2 className="mb-3 text-headline-semibold text-text-primary">学习范围 · {active.length}</h2>
          <DecisionList decisions={active} />
        </Card>
      </div>
    </>
  );
}

export function DecisionList({ decisions, compact }: { decisions: OpenDecision[]; compact?: boolean }) {
  if (!decisions.length) return <Empty>没有待办决策</Empty>;
  return (
    <ul className="-my-3 flex flex-col divide-y divide-separator-border">
      {decisions.map((d) => {
        const a = ACTION[d.action] ?? { label: d.action, color: "neutral" as const };
        const body = (
          <>
            <div className="flex w-14 shrink-0 flex-col items-start gap-1 pt-0.5">
              <Chip variant="caption" color={a.color}>
                {a.label}
              </Chip>
              {d.priority ? (
                <span className="text-caption-2-medium text-text-tertiary">优先级 {d.priority}</span>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body-medium text-text-primary">{d.title ? <MathText>{d.title}</MathText> : (d.course ?? "整门课")}</span>
                {d.node_id && d.course ? <span className="text-caption-1-regular text-text-tertiary">{d.course}</span> : null}
                {d.node_id ? <ValuePips value={d.exam_value} /> : null}
                {d.stale && d.status === "planned" ? (
                  <Chip variant="caption" color="yellow" title="做出这条决策后，这个知识点的状态又被重新评估过">
                    可能已过时
                  </Chip>
                ) : null}
              </div>
              <span className="text-body-2-regular text-text-secondary"><MathText>{d.reason}</MathText></span>
              {!compact && (d.condition || d.status) ? (
                <span className="text-caption-1-regular text-text-tertiary">
                  {DECISION_STATUS[d.status]}
                  {d.condition ? ` · 条件：${d.condition}` : ""} · {fmtTime(d.decided_at, false)}
                </span>
              ) : d.condition ? (
                <span className="text-caption-1-regular text-text-tertiary">条件：{d.condition}</span>
              ) : null}
            </div>
          </>
        );
        const cls = "flex gap-3 py-3";
        return (
          <li key={d.id}>
            {d.node_id ? (
              <a
                href={href.node(d.node_id)}
                className={cx(cls, "-mx-2 rounded-xl px-2 outline-none hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring")}
              >
                {body}
              </a>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
