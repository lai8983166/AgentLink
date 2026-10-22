import { useEffect, useState } from "react";
import type { RateLimit } from "@agentlink/shared";
import { quotaTime, quotaWindowLabel, remainingPercent } from "../quota";

export function QuotaStatus({ rate, loading = false, error = false }: { rate?: RateLimit | null; loading?: boolean; error?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, 15_000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);
  const currentTime = Math.max(now, Date.now());
  if (!rate || (!rate.primary && !rate.secondary)) return <div className="quota-status" data-testid="quota-status">{loading ? "额度读取中…" : "额度暂不可用"}</div>;
  const historical = rate.source === "history";
  const stale = !rate.measuredAt || currentTime - rate.measuredAt > 120_000;
  const failed = error || rate.refreshFailed;
  const uncertain = historical || stale || failed;
  const windows = [rate.primary, rate.secondary];
  return <div className="quota-status" data-testid="quota-status">
    <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 12px" }}>
      {windows.map((w, index) => {
        if (!w) return null;
        const label = quotaWindowLabel(w.windowDurationMins);
        const expired = w.resetsAt * 1000 <= currentTime;
        const full = !uncertain && !expired && w.usedPercent >= 100;
        return <span key={index} style={full ? { color: "var(--red)" } : undefined}>
          {label}{expired ? "：等待更新" : `${uncertain ? "上次" : ""}剩余 ${remainingPercent(w.usedPercent)}${full ? "（已用尽）" : ""}`}
          {!expired && <span style={{ opacity: 0.8 }}> · {quotaTime(w.resetsAt * 1000)} 重置</span>}
        </span>;
      })}
    </div>
    <div style={{ opacity: 0.8, marginTop: 2 }}>
      {historical ? "历史记录" : rate.source === "notification" ? "官方推送" : rate.source === "official" ? "官方额度" : "上次记录"}
      {rate.measuredAt ? ` · ${quotaTime(rate.measuredAt)} 更新` : " · 时间未知"}
      {failed ? " · 刷新失败" : stale ? " · 数据已过期" : ""}
      {rate.rateLimitReachedType && !uncertain && " · 官方报告额度受限"}
    </div>
  </div>;
}
