import { useApi, type Overview as OverviewData } from "@/lib/api";
import { fmtTime } from "@/lib/labels";
import { MathText } from "@/components/math-text";
import { href } from "@/lib/router";
import { Card, CardTitle, Empty, ErrorCard, Loading, PageHeader } from "@/components/ui";
import { DecisionList } from "./Decisions";

export function DashboardPage() {
  const { data, error, loading } = useApi<OverviewData>("/overview");
  if (loading) return <Loading />;
  if (error || !data) return <ErrorCard error={error!} />;

  return (
    <>
      <PageHeader title="仪表盘" />
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardTitle
            extra={
              <a href={href.decisions} className="text-caption-1-medium text-text-tertiary hover:text-text-secondary">
                全部
              </a>
            }
          >
            下一步
          </CardTitle>
          <DecisionList decisions={data.open_decisions.filter((d) => d.status === "planned").slice(0, 6)} compact />
        </Card>
        <Card>
          <CardTitle>最近学习</CardTitle>
          {data.last_sessions.length === 0 ? (
            <Empty>还没有学习记录</Empty>
          ) : (
            <ol className="flex flex-col gap-4">
              {data.last_sessions.map((s) => (
                <li key={s.id} className="flex flex-col gap-1 border-s-2 border-separator-border ps-3">
                  <span className="text-caption-1-medium text-text-tertiary">
                    {fmtTime(s.started_at)}
                    {s.course ? ` · ${s.course}` : ""}
                    {s.planned_min ? ` · 计划 ${s.planned_min} 分钟` : ""}
                    {s.goal ? ` · ${s.goal}` : ""}
                  </span>
                  <span className="text-body-2-regular text-text-primary">{s.summary ? <MathText>{s.summary}</MathText> : "（未写总结）"}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
