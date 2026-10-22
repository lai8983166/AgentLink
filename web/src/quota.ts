import type { RateLimit } from "@agentlink/shared";

/** HTTP 慢响应不能覆盖已经收到的额度推送，包括账户清空和刷新失败状态。 */
export function mergeQuota(current: RateLimit | null | undefined, incoming: RateLimit | null): RateLimit | null {
  if (!current || !incoming) return incoming;
  const before = current.updatedAt ?? current.measuredAt ?? 0;
  const after = incoming.updatedAt ?? incoming.measuredAt ?? 0;
  return before > after ? current : incoming;
}

export function quotaWindowLabel(minutes: number): string {
  if (minutes === 10080) return "每周";
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function remainingPercent(used: number): string {
  const remaining = Math.max(0, Math.min(100, 100 - used));
  return remaining > 0 && remaining < 1 ? "<1%" : `${Math.round(remaining)}%`;
}

export function quotaTime(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
