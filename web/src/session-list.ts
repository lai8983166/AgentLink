import type { SessionSummary } from "@agentlink/shared";

export const RECENT_ACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;
/** 活跃时间来自会话本身；连接检查、页面打开与状态查询不会延长此窗口。 */
export function recentSessions(sessions: SessionSummary[], now = Date.now()): SessionSummary[] {
  return sessions.filter(s => Number.isFinite(s.lastActivityAt) && s.lastActivityAt > 0 && s.lastActivityAt >= now - RECENT_ACTIVITY_MS);
}
