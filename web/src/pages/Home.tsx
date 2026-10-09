import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListEvent, SessionSummary } from "@agentlink/shared";
import { api, ws } from "../runtime";
import { STATUS_ORDER, useStore } from "../store";
import { NewTaskSheet } from "../components/NewTaskSheet";
import { useEffect } from "react";

/** 电脑上正被其他入口使用的会话排在运行中之后、已完成之前 */
function effectiveOrder(s: SessionSummary): number {
  return STATUS_ORDER[s.status];
}

/** 首页：会话列表 + 待审批横幅 + 连接 pill + 额度（任务 7.3） */
export function Home() {
  const queryClient = useQueryClient();
  const wsConnected = useStore((s) => s.wsConnected);
  const [sheetOpen, setSheetOpen] = useState(false);

  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(),
    refetchInterval: 15000, // 电脑端活动（rollout updatedAt）实时反映到列表顺序
  });
  const statusQ = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    refetchInterval: 15000,
  });

  // 列表级事件：增量更新缓存（WS 驱动，轮询兜底）；账户限额 → 状态缓存
  useEffect(() => {
    return ws.subscribeList((e: ListEvent) => {
      if (e.type === "account.limits") {
        queryClient.setQueryData(["status"], (old: unknown) =>
          old ? { ...(old as object), rateLimits: e.limits } : old,
        );
        return;
      }
      if (!("summary" in e)) return;
      queryClient.setQueryData(["sessions"], (old: { sessions: SessionSummary[] } | undefined) => {
        if (!old) return old;
        const list = [...old.sessions];
        const i = list.findIndex((s) => s.id === e.summary.id);
        if (e.type === "session.deleted") {
          if (i >= 0) list.splice(i, 1);
        } else if (i >= 0) list[i] = e.summary;
        else list.unshift(e.summary);
        return { sessions: list };
      });
    });
  }, [queryClient]);

  const sessions = [...(sessionsQ.data?.sessions ?? [])].sort(
    (a, b) =>
      effectiveOrder(a) - effectiveOrder(b) || b.lastActivityAt - a.lastActivityAt,
  );
  const waiting = sessions.filter((s) => s.status === "waiting_approval");
  const active = sessions.filter(
    (s) => s.status === "running" || s.status === "waiting_approval",
  );
  const rest = sessions.filter(
    (s) => s.status !== "running" && s.status !== "waiting_approval",
  );
  const rate = statusQ.data?.rateLimits;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <div className="topbar">
        <div className="title">
          <div className="name">
            <span className="logo" />
            AgentLink
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10.5,
              color: "var(--text-dim)",
              fontFamily: "var(--mono)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: "3px 10px",
              borderRadius: 99,
              marginTop: 5,
            }}
          >
            <span style={{ color: wsConnected ? "var(--green)" : "var(--red)" }}>●</span>
            家里PC · {wsConnected ? "已连接" : "连接中…"}
            {rate &&
              (() => {
                const p5 = Math.round(rate.primary.usedPercent);
                const sec = rate.secondary;
                const wk = sec ? Math.round(sec.usedPercent) : null;
                const weekFull = wk != null && wk >= 99;
                const full = p5 >= 99 || weekFull;
                const resetAt = new Date((weekFull && sec ? sec : rate.primary).resetsAt * 1000);
                const hhmm = `${String(resetAt.getHours()).padStart(2, "0")}:${String(resetAt.getMinutes()).padStart(2, "0")}`;
                const stale =
                  "measuredAt" in rate && typeof rate.measuredAt === "number" && Date.now() - rate.measuredAt > 15 * 60_000
                    ? `（${new Date(rate.measuredAt).getHours()}:${String(new Date(rate.measuredAt).getMinutes()).padStart(2, "0")} 数据）`
                    : "";
                return (
                  <span style={full ? { color: "var(--red)", fontWeight: 700 } : undefined}>
                    {" · "}
                    {full ? `额度用尽 ${hhmm} 重置` : `额度 ${p5}%${wk != null ? ` / 周 ${wk}%` : ""}`}
                    {stale}
                  </span>
                );
              })()}
          </div>
        </div>
        <Link to="/settings" className="icon-btn">
          ⚙
        </Link>
      </div>

      <div className="content">
        {waiting.length > 0 && (
          <Link
            to={`/${waiting[0]!.id}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "var(--gold)",
              border: "1.5px solid var(--border)",
              boxShadow: "var(--ink-shadow)",
              borderRadius: 12,
              padding: "12px 14px",
              margin: "14px 0 6px",
              textDecoration: "none",
              color: "var(--text)",
            }}
          >
            <span>⚠️</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 550 }}>
              <b>{waiting.length} 个请求等待审批</b> · {waiting[0]!.title}
            </span>
            <span style={{ fontWeight: 700 }}>›</span>
          </Link>
        )}

        {active.length > 0 && <div className="section-label">进行中</div>}
        {active.map((s) => (
          <SessionCard key={s.id} s={s} alert={s.status === "waiting_approval"} />
        ))}

        {rest.length > 0 && <div className="section-label">其他会话</div>}
        {rest.map((s) => (
          <SessionCard key={s.id} s={s} dim={s.status === "idle"} />
        ))}

        {sessionsQ.isLoading && <div className="empty-note">加载中…</div>}
        {sessionsQ.isError && <div className="empty-note">加载失败，下拉重试</div>}
        {!sessionsQ.isLoading && sessions.length === 0 && (
          <div className="empty-note">还没有会话 · 点右下角 ＋ 派个任务</div>
        )}
      </div>

      <div className="fab" onClick={() => setSheetOpen(true)}>
        ＋
      </div>
      {sheetOpen && <NewTaskSheet onClose={() => setSheetOpen(false)} />}
    </div>
  );
}

function SessionCard({ s, alert, dim }: { s: SessionSummary; alert?: boolean; dim?: boolean }) {
  const statusLabel: Record<string, string> = {
    running: "运行中",
    waiting_approval: "等待审批",
    done: "已完成",
    error: "出错",
    idle: "空闲",
    unknown: s.desktopGone ? "电脑端未连接" : "状态待确认",
  };
  const dot = s.status === "waiting_approval" ? "waiting" : s.status;
  return (
    <Link to={`/${s.id}`} className={`card${alert ? " alert" : ""}${dim ? " dim" : ""}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={`dot ${dot}`} />
        <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.forkedFromId && <span title="接力会话" style={{ marginRight: 4 }}>🧬</span>}
          <i className="hash">#</i>
          {s.title || "会话"}
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, color: "var(--text-dim)", border: "1px solid rgba(34,28,14,.55)", padding: "1px 6px", borderRadius: 6 }}>
          CODEX
        </span>
        <span className={`chip ${s.status}`}>{statusLabel[s.status]}</span>
      </div>
      {s.cwd && (
        <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.cwd}
        </div>
      )}
      {s.preview && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, fontSize: 12.5, color: s.status === "done" ? "var(--green)" : "var(--text-dim)" }}>
          <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.preview.slice(0, 60)}</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)", flexShrink: 0 }}>
            {s.lastActivityAt ? relTime(s.lastActivityAt) : "—"}
          </span>
        </div>
      )}
    </Link>
  );
}

function relTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}
