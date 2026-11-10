import { useEffect, useState } from "react";

// A 401 from any call clears the stored token, which sends the app back to TokenPage.
const TOKEN_KEY = "learning-knowledge:token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked (private mode): the token lives for this page only
  }
  window.dispatchEvent(new Event("token-change"));
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, token = getToken()): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      // non-JSON error body: keep the HTTP status message
    }
    if (r.status === 401) setToken(null);
    throw new ApiError(r.status, msg);
  }
  return (await r.json()) as T;
}

export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState({ loading: true });
    api<T>(path).then(
      (data) => live && setState({ data, loading: false }),
      (error: ApiError) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

// Response shapes below are hand-copied from src/worker/tools.ts; update both together.
export type Level = "unknown" | "exposed" | "assisted" | "independent" | "validated" | "weak" | "recheck";

export interface Assessment {
  id: number;
  course_id: number;
  name: string;
  exam_date: string | null;
  exam_format: string | null;
  scope_note: string | null;
  status: "upcoming" | "done" | "dropped";
}

export interface Course {
  id: number;
  name: string;
  status: "active" | "paused" | "done";
  subject: string | null;
  kind: "course" | "foundation";
  created_at: string;
  node_count: number;
  assessments: Assessment[];
  levels: Partial<Record<Level, number>>;
}

export interface OpenDecision {
  id: number;
  node_id: number | null;
  title: string | null;
  course_id: number | null;
  course: string | null;
  assessment_id: number | null;
  action: string;
  reason: string;
  condition: string | null;
  priority: number | null;
  status: string;
  exam_value: number | null;
  decided_at: string;
  stale?: number | null;
}

export interface Session {
  id: number;
  course_id: number | null;
  course: string | null;
  started_at: string;
  planned_min: number | null;
  goal: string | null;
  summary: string | null;
}

export interface Overview {
  courses: Course[];
  open_decisions: OpenDecision[];
  last_sessions: Session[];
}

export interface TreeNode {
  id: number;
  title: string;
  kind: string;
  definition: string | null;
  level: Level;
  weak_point: string | null;
  assessed_at: string | null;
  suggested_level: Level;
  last_seen: string | null;
}

export interface Edge {
  from_id: number;
  to_id: number;
  relation: "prerequisite_of" | "part_of" | "confused_with" | "contrasts_with" | "analogous_to";
  note: string | null;
  weight?: number;
  needed_layer?: "use" | "mechanism" | "principle" | "boundary" | null;
}

export interface ExternalNode {
  id: number;
  title: string;
  kind: string;
  course_id: number;
  course: string;
  subject: string | null;
  level: Level;
}

export interface ValueRow {
  node_id: number;
  assessment_id: number;
  value: number | null;
  uncertainty: "low" | "medium" | "high";
}

export interface ScopeDecision {
  node_id: number;
  assessment_id: number | null;
  action: "learn" | "skim" | "skip";
  reason: string;
  condition: string | null;
}

export interface CourseTree {
  course: Omit<Course, "assessments" | "levels" | "node_count">;
  assessments: Assessment[];
  nodes: TreeNode[];
  values: ValueRow[];
  edges: Edge[];
  external_nodes?: ExternalNode[];
  scope_decisions: ScopeDecision[];
}

export interface StateRow {
  id: number;
  node_id: number;
  assessed_at: string;
  level: Level;
  weak_point: string | null;
  basis: string;
  rationale: string | null;
  assessed_by: "rule" | "ai" | "self";
}

export interface EvidenceRow {
  id: number;
  kind: "step" | "exposure" | "prediction" | "self_explain" | "self_report";
  representation: string | null;
  interpretation: string | null;
  outcome: string | null;
  qualifier: string | null;
  note: string | null;
  observed_at: string;
  attempt_id: number | null;
  context: string | null;
  hints: string | null;
  overall: string | null;
  self_signal: string | null;
  confidence: number | null;
  task_source: string | null;
  source_ref: string | null;
  task_prompt: string | null;
  step_no: number | null;
  role: string | null;
  step_description: string | null;
  difficulties: string[];
}

export interface DecisionRow {
  id: number;
  node_id: number | null;
  course_id: number | null;
  decided_at: string;
  assessment_id: number | null;
  action: string;
  reason: string;
  condition: string | null;
  priority: number | null;
  status: string;
  revoked_at: string | null;
  revoked_why: string | null;
  outcome: string | null;
  stale?: number | null;
}

export interface RelatedEdge {
  relation: Edge["relation"];
  note: string | null;
  weight?: number;
  needed_layer?: Edge["needed_layer"];
  node_id: number;
  title: string;
  course_id?: number;
  course?: string;
  subject?: string | null;
  level?: Level;
}

export interface NodeDetail {
  node: {
    id: number;
    course_id: number;
    course: string;
    title: string;
    kind: string;
    usage?: string | null;
    definition: string | null;
    intuition: string | null;
    boundary: string | null;
    pitfalls: string | null;
    created_at: string;
  };
  current_state: Partial<StateRow> & { level: Level };
  state_history: StateRow[];
  representations_tried?: { representation: string; times_used: number; last_used: string; failed_checks: number }[];
  rule_baseline: { node_id: number; last_seen: string | null; suggested_level: Level } | null;
  values: (ValueRow & { id: number; assessment: string; basis: string; sources: string | null; assessed_at: string })[];
  edges: {
    outgoing: RelatedEdge[];
    incoming: RelatedEdge[];
  };
  evidence: EvidenceRow[];
  decisions: DecisionRow[];
}
