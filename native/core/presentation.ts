import type { SessionDetailResponse, SessionSummary, RateLimit } from "../../shared/src/index";
import { quotaTime, quotaWindowLabel, remainingPercent } from "../../web/src/quota";
import { canControl } from "./client";

export const policyLabels = { untrusted: "每次询问", "on-request": "失败时询问", never: "全自动" };
export const statusLabels = { running: "运行中", waiting_approval: "等待审批", done: "已完成", idle: "空闲", error: "出错", unknown: "状态待确认" };
export function statusLabel(s: SessionSummary) {
  return s.status === "unknown" && s.agent === "claude" && !s.terminal?.connected ? "终端未连接" : s.status === "unknown" && s.desktopGone ? "电脑端未连接" : statusLabels[s.status];
}
export function relativeTime(at: number) {
  if (!at) return "—";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  return seconds < 60 ? "刚刚" : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 86400)} 天前`;
}
export function controls(detail: SessionDetailResponse | undefined, fresh: boolean, errorCode = "") {
  const s = detail?.session;
  const enabled = !!s && fresh && !detail?.historyPage?.cached && s.status !== "unknown";
  const drive = canControl(detail, fresh) && !s?.desktopGone;
  const desktop = !!s && s.agent === "codex" && !drive && (!!s.desktopManaged || (!!s.activeElsewhere && !s.desktopGone));
  return { drive, desktop, takeover: enabled && desktop, resume: enabled && desktop,
    fork: enabled && desktop && errorCode === "IPC_OWNER_NOT_FOUND",
    interrupt: drive && (s?.status === "running" || s?.status === "waiting_approval") && (s?.agent !== "claude" || !!s.terminal?.canInterrupt),
    policy: drive && s?.agent === "codex" };
}
export function quotaLines(rate: RateLimit | null | undefined, failed = false, now = Date.now()) {
  if (!rate || (!rate.primary && !rate.secondary)) return ["额度暂不可用"];
  const stale = !rate.measuredAt || now - rate.measuredAt > 120000;
  const uncertain = stale || failed || rate.refreshFailed || rate.source === "history";
  const lines = [rate.primary, rate.secondary].filter(w => !!w).map(w => {
    const expired = w!.resetsAt * 1000 <= now;
    return quotaWindowLabel(w!.windowDurationMins) + (expired ? "：等待更新" : `${uncertain ? "上次" : ""}剩余 ${remainingPercent(w!.usedPercent)}${!uncertain && w!.usedPercent >= 100 ? "（已用尽）" : ""} · ${quotaTime(w!.resetsAt * 1000)} 重置`);
  });
  lines.push(`${rate.source === "history" ? "历史记录" : rate.source === "notification" ? "官方推送" : rate.source === "official" ? "官方额度" : "上次记录"}${rate.measuredAt ? ` · ${quotaTime(rate.measuredAt)} 更新` : " · 时间未知"}${failed || rate.refreshFailed ? " · 刷新失败" : stale ? " · 数据已过期" : ""}`);
  return lines;
}
