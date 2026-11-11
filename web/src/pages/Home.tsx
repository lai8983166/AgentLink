import { themedStyle } from "../../../shared/src/ui-theme";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListEvent, SessionSummary, SessionListResponse, StatusResponse } from "@agentlink/shared";
import { api, ws } from "../runtime";
import { STATUS_ORDER, useStore } from "../store";
import { NewTaskSheet } from "../components/NewTaskSheet";
import { useEffect } from "react";
import { mergeSessionList, mergeSessionSummary } from "../session-cache";
import { usePullToRefresh } from "../pull-to-refresh";
import { UpdateNotice } from "../components/UpdateNotice";
import { QuotaStatus } from "../components/QuotaStatus";
import { mergeQuota } from "../quota";
import { recentSessions } from "../session-list";

/** 电脑上正被其他入口使用的会话排在运行中之后、已完成之前 */
function effectiveOrder(s: SessionSummary): number {
  return STATUS_ORDER[s.status];
}

/** 首页：会话列表 + 待审批横幅 + 连接 pill + 额度（任务 7.3） */
export function Home() {
  const [params] = useSearchParams();
  const catalogAgent = params.get("view") === "all" && ["codex", "claude"].includes(params.get("agent") ?? "")
    ? params.get("agent") as "codex" | "claude" : undefined;
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(50);
  const listKey = catalogAgent ? ["sessions", "all", catalogAgent] : ["sessions"];
  const queryClient = useQueryClient();
  const wsConnected = useStore((s) => s.wsConnected);
  const [sheetOpen, setSheetOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const refreshBusy = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const sessionsQ = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const incoming = await api.sessions(catalogAgent ? { agent: catalogAgent, scope: "all" } : undefined);
      return mergeSessionList(queryClient.getQueryData<SessionListResponse>(listKey), incoming);
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 15000,
  });
  const statusQ = useQuery({
    queryKey: ["status"],
    queryFn: () => readStatus(),
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 15000,
  });

  async function readStatus(force = false) {
    const before = queryClient.getQueryData<StatusResponse>(["status"]);
    const incoming = await api.status(force);
    const current = queryClient.getQueryData<StatusResponse>(["status"]);
    const rateLimits = !incoming.rateLimits && current?.rateLimits !== before?.rateLimits
      ? current?.rateLimits ?? null : mergeQuota(current?.rateLimits, incoming.rateLimits);
    return { ...incoming, rateLimits };
  }

  async function refresh() {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const results = await Promise.allSettled([
        sessionsQ.refetch({ cancelRefetch: false }),
        readStatus(true).then((incoming) => {
          queryClient.setQueryData<StatusResponse>(["status"], (old) => ({ ...incoming, rateLimits: mergeQuota(old?.rateLimits, incoming.rateLimits) }));
          return { isError: false };
        }),
      ]);
      const failed = results.some((result) => result.status === "rejected" || result.value.isError);
      setRefreshNote(failed ? "刷新失败，请重试" : "已刷新");
    } finally {
      refreshBusy.current = false;
      setRefreshing(false);
    }
  }
  const pull = usePullToRefresh(listRef, refresh, refreshing);
  useEffect(() => { setSearch(""); setShown(50); if (listRef.current) listRef.current.scrollTop = 0; }, [catalogAgent]);

  // 列表级事件：增量更新缓存（WS 驱动，轮询兜底）；账户限额 → 状态缓存
  useEffect(() => {
    return ws.subscribeList((e: ListEvent) => {
      if (e.type === "account.limits") {
        queryClient.setQueryData<StatusResponse>(["status"], (old) =>
          old ? { ...old, rateLimits: mergeQuota(old.rateLimits, e.limits) } : old,
        );
        return;
      }
      if (!("summary" in e)) return;
      if (catalogAgent && e.summary.agent !== catalogAgent) return;
      queryClient.setQueryData(listKey, (old: { sessions: SessionSummary[] } | undefined) => {
        const list = [...(old?.sessions ?? [])];
        const i = list.findIndex((s) => s.id === e.summary.id);
        if (e.type === "session.deleted") {
          if (i >= 0) list.splice(i, 1);
        } else if (i >= 0) list[i] = mergeSessionSummary(list[i], e.summary);
        else list.unshift(e.summary);
        return { ...old, sessions: list };
      });
    });
  }, [queryClient, catalogAgent]);

  const available = sessionsQ.data?.sessions ?? [];
  const selected = catalogAgent ? available.filter(s => s.agent === catalogAgent) : recentSessions(available);
  const matched = selected.filter(s => !search.trim() || (s.title + " " + s.cwd).toLowerCase().includes(search.trim().toLowerCase()));
  const sessions = [...matched].sort(
    (a, b) =>
      effectiveOrder(a) - effectiveOrder(b) || b.lastActivityAt - a.lastActivityAt,
  ).slice(0, catalogAgent ? shown : undefined);
  const waiting = sessions.filter((s) => s.status === "waiting_approval");
  const active = sessions.filter(
    (s) => s.status === "running" || s.status === "waiting_approval",
  );
  const rest = sessions.filter(
    (s) => s.status !== "running" && s.status !== "waiting_approval",
  );
  const rate = statusQ.data?.rateLimits;

  return (
    <div style={themedStyle({ display: "flex", flexDirection: "column", height: "100dvh" })}>
      <div className="topbar">
        {catalogAgent && <Link to="/" className="back" aria-label="返回最近会话">‹</Link>}
        <div className="title">
          <div className="name">
            <span className="logo" />
            {catalogAgent ? catalogAgent === "codex" ? "全部 Codex 会话" : "全部 Claude Code 会话" : "AgentLink"}
          </div>
          <div
            style={themedStyle({
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
            })}
          >
            <span style={themedStyle({ color: wsConnected ? "var(--green)" : "var(--red)" })}>●</span>
            手机与后台 · {wsConnected ? "已连接" : "连接中…"}
            {statusQ.data?.connections && <span> · 桌面{statusQ.data.connections.desktop === "ready" ? "已连接" : "待连接"}</span>}
          </div>
          <QuotaStatus rate={rate} loading={statusQ.isPending} error={statusQ.isError} />
        </div>
        <button className="icon-btn" aria-label="刷新会话" title="刷新会话" disabled={refreshing} onClick={refresh}>
          ↻
        </button>
        <Link to="/settings" className="icon-btn" aria-label="设置">
          ⚙
        </Link>
      </div>

      <UpdateNotice />
      {!catalogAgent ? <nav aria-label="查看全部会话" style={themedStyle({ display: "flex", gap: 8, padding: "8px 16px", flexShrink: 0 })}>
        <Link className="btn ghost" to="/?view=all&agent=codex" style={themedStyle({ flex: 1, fontSize: 12 })}>全部 Codex 会话 ›</Link>
        <Link className="btn ghost" to="/?view=all&agent=claude" style={themedStyle({ flex: 1, fontSize: 12 })}>全部 Claude Code 会话 ›</Link>
      </nav> : <div style={themedStyle({ padding: "8px 16px", flexShrink: 0 })}>
        <input aria-label="搜索全部会话" placeholder="搜索标题或项目路径" value={search} onChange={e => { setSearch(e.target.value); setShown(50); }} style={themedStyle({ width: "100%", boxSizing: "border-box", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", fontSize: 16 })} />
        <div style={themedStyle({ fontSize: 11, color: "var(--text-dim)", marginTop: 5 })}>不限制活跃时间 · {matched.length} 个会话</div>
      </div>}
      {(pull.distance > 0 || refreshing || refreshNote) && (
        <div className="refresh-indicator" role="status" style={themedStyle({ height: Math.max(28, pull.distance / 2) })}>
          {refreshing ? "刷新中…" : pull.distance > 0 ? pull.armed ? "松开刷新" : "继续下拉以刷新" : refreshNote}
        </div>
      )}
      <div className="content session-list" data-testid="session-list" ref={listRef} aria-busy={refreshing}>
        {!catalogAgent && <div className="section-label">最近 30 天活跃</div>}
        {sessionsQ.data?.warnings?.map(warning => <div role="status" key={warning} style={themedStyle({ color: "var(--red)", fontSize: 12, padding: "8px 0" })}>{warning}</div>)}
        {waiting.length > 0 && (
          <Link
            to={`/${waiting[0]!.id}`}
            style={themedStyle({
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
            })}
          >
            <span>⚠️</span>
            <span style={themedStyle({ flex: 1, fontSize: 13, fontWeight: 550 })}>
              <b>{waiting.length} 个请求等待审批</b> · {waiting[0]!.title}
            </span>
            <span style={themedStyle({ fontWeight: 700 })}>›</span>
          </Link>
        )}

        {active.length > 0 && <div className="section-label">进行中</div>}
        {active.map((s) => (
          <SessionCard key={s.id} s={s} alert={s.status === "waiting_approval"} backTo={catalogAgent ? "/?view=all&agent=" + catalogAgent : "/"} />
        ))}

        {rest.length > 0 && <div className="section-label">其他会话</div>}
        {rest.map((s) => (
          <SessionCard key={s.id} s={s} dim={s.status === "idle"} backTo={catalogAgent ? "/?view=all&agent=" + catalogAgent : "/"} />
        ))}
        {catalogAgent && matched.length > shown && <button className="btn ghost" style={themedStyle({ margin: "12px auto" })} onClick={() => setShown(n => n + 50)}>加载更多会话</button>}

        {sessionsQ.isLoading && <div className="empty-note">加载中…</div>}
        {sessionsQ.isError && <div className="empty-note">
          加载失败，可下拉或点击刷新重试
          <button className="btn ghost" style={themedStyle({ margin: "10px auto" })} disabled={refreshing} onClick={refresh}>重试加载</button>
        </div>}
        {!sessionsQ.isLoading && !sessionsQ.isError && sessions.length === 0 && (
          <div className="empty-note">{catalogAgent ? search ? "没有匹配的会话" : "还没有会话" : "最近 30 天还没有会话 · 可从上方查看全部会话"}</div>
        )}
      </div>

      <div className="fab" onClick={() => setSheetOpen(true)}>
        ＋
      </div>
      {sheetOpen && <NewTaskSheet onClose={() => setSheetOpen(false)} />}
    </div>
  );
}

function SessionCard({ s, alert, dim, backTo }: { s: SessionSummary; alert?: boolean; dim?: boolean; backTo: string }) {
  const queryClient = useQueryClient();
  const statusLabel: Record<string, string> = {
    running: "运行中",
    waiting_approval: "等待审批",
    done: "已完成",
    error: "出错",
    idle: "空闲",
    unknown: s.agent === "claude" && !s.terminal?.connected ? "终端未连接" : s.desktopGone ? "电脑端未连接" : "状态待确认",
  };
  const dot = s.status === "waiting_approval" ? "waiting" : s.status;
  return (
    <Link to={`/${s.id}`} state={{ listBackTo: backTo }} onClick={() => queryClient.setQueryData(["session-summary", s.id], s)} className={`card${alert ? " alert" : ""}${dim ? " dim" : ""}`} style={themedStyle({ textDecoration: "none", color: "inherit", display: "block" })}>
      <div style={themedStyle({ display: "flex", alignItems: "center", gap: 8 })}>
        <span className={`dot ${dot}`} />
        <span style={themedStyle({ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" })}>
          {s.forkedFromId && <span title="接力会话" style={themedStyle({ marginRight: 4 })}>🧬</span>}
          <i className="hash">#</i>
          {s.title || "会话"}
        </span>
        <span style={themedStyle({ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, color: "var(--text-dim)", border: "1px solid rgba(34,28,14,.55)", padding: "1px 6px", borderRadius: 6 })}>
          {s.agent === "claude" ? "CLAUDE" : "CODEX"}
        </span>
        <span className={`chip ${s.status}`}>{statusLabel[s.status]}</span>
      </div>
      {s.cwd && (
        <div style={themedStyle({ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" })}>
          {s.cwd}
        </div>
      )}
      {s.preview && (
        <div style={themedStyle({ display: "flex", alignItems: "center", gap: 6, marginTop: 9, fontSize: 12.5, color: s.status === "done" ? "var(--green)" : "var(--text-dim)" })}>
          <span style={themedStyle({ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" })}>{s.preview.slice(0, 60)}</span>
          <span style={themedStyle({ marginLeft: "auto", fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)", flexShrink: 0 })}>
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
