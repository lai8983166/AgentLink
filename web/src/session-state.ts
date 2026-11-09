import { historyItemKey, type SessionDetailResponse, type SessionEvent } from "@agentlink/shared";
import { applyEventToHistory } from "../../shared/src/history-reducer";

/** 详情快照与实时事件共享序号，迟到的快照不能覆盖已经收到的事件。 */
export function mergeSessionDetail(current: SessionDetailResponse | undefined, incoming: SessionDetailResponse): SessionDetailResponse {
  if (current && current.session.id === incoming.session.id && current.serverEpoch === incoming.serverEpoch && current.latestSeq > incoming.latestSeq) {
    // 翻页期间仍会收到实时输出：只补当前首条之前的旧记录，不回滚状态和新消息。
    if (incoming.historyPage && current.session.history.length) {
      const anchor = incoming.session.history.findIndex(item => historyItemKey(item) === historyItemKey(current.session.history[0]!));
      if (anchor > 0) {
        const known = new Set(current.session.history.map(historyItemKey));
        const prefix = incoming.session.history.slice(0, anchor).filter(item => !known.has(historyItemKey(item)));
        if (prefix.length) return { ...current, historyPage: incoming.historyPage, session: { ...current.session, history: [...prefix, ...current.session.history] } };
      }
    }
    return current;
  }
  return incoming;
}

/** Apply confirmed ownership without rolling back events that arrived during the resume response. */
export function mergeResumedDetail(current: SessionDetailResponse | undefined, incoming: SessionDetailResponse): SessionDetailResponse {
  const merged = mergeSessionDetail(current, incoming);
  if (merged !== current || !current) return merged;
  const { controlMode, desktopManaged, desktopGone, activeElsewhere, activeVia, approvalPolicy } = incoming.session;
  return { ...current, session: { ...current.session, controlMode, desktopManaged, desktopGone, activeElsewhere, activeVia, approvalPolicy } };
}

export function applySessionEvent(current: SessionDetailResponse | undefined, e: SessionEvent): SessionDetailResponse | undefined {
  if (!current || current.session.id !== e.sessionId) return current;
  if (e.serverEpoch && current.serverEpoch && e.serverEpoch !== current.serverEpoch) return current;
  if (e.seq <= current.latestSeq) return current;
  let session = { ...current.session };
  if (e.type === "session.status") session = { ...session, status: e.status, statusUpdatedAt: e.at };
  if (e.type === "session.terminal") session = { ...session, terminal: e.terminal };
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
