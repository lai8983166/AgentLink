import type { SessionListResponse, SessionSummary } from "@agentlink/shared";

/** 旧 HTTP 响应或迟到事件不能回滚较新的权威状态。 */
export function mergeSessionSummary(current: SessionSummary | undefined, incoming: SessionSummary): SessionSummary {
  if (!current || (incoming.statusUpdatedAt ?? 0) >= (current.statusUpdatedAt ?? 0)) return incoming;
  return {
    ...incoming,
    status: current.status,
    statusUpdatedAt: current.statusUpdatedAt,
    pendingApprovals: current.pendingApprovals,
    activeElsewhere: current.activeElsewhere,
    desktopGone: current.desktopGone,
  };
}

export function mergeSessionList(current: SessionListResponse | undefined, incoming: SessionListResponse): SessionListResponse {
  const existing = new Map(current?.sessions.map((s) => [s.id, s]) ?? []);
  return { sessions: incoming.sessions.map((s) => mergeSessionSummary(existing.get(s.id), s)) };
}
