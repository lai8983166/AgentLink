import type { SessionDetailResponse, SessionEvent } from "@agentlink/shared";
import { applyEventToHistory } from "./store";

/** 详情快照与实时事件共享序号，迟到的快照不能覆盖已经收到的事件。 */
export function mergeSessionDetail(current: SessionDetailResponse | undefined, incoming: SessionDetailResponse): SessionDetailResponse {
  if (current && current.session.id === incoming.session.id && current.serverEpoch === incoming.serverEpoch && current.latestSeq > incoming.latestSeq) return current;
  return incoming;
}

export function applySessionEvent(current: SessionDetailResponse | undefined, e: SessionEvent): SessionDetailResponse | undefined {
  if (!current || current.session.id !== e.sessionId) return current;
  if (e.serverEpoch && current.serverEpoch && e.serverEpoch !== current.serverEpoch) return current;
  if (e.seq <= current.latestSeq) return current;
  let session = { ...current.session };
  if (e.type === "session.status") session = { ...session, status: e.status, statusUpdatedAt: e.at };
  if (e.type === "approval.request") {
    const approvals = (session.approvals ?? []).filter((a) => a.approvalId !== e.approvalId);
    approvals.push({ approvalId: e.approvalId, kind: e.kind, command: e.command, cwd: e.cwd,
      reason: e.reason, availableDecisions: e.availableDecisions });
    session.approvals = approvals;
  }
  if (e.type === "approval.resolved") session.approvals = (session.approvals ?? []).filter((a) => a.approvalId !== e.approvalId);
  session.history = applyEventToHistory(session.history, e);
  return { ...current, session, latestSeq: e.seq };
}
