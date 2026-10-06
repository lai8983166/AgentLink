import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionEvent } from "@agentlink/shared";
import { api, ws } from "../runtime";
import { applyEventToHistory, followState } from "../store";
import { ApprovalCard, type PendingApprovalUI } from "../components/ApprovalCard";
import { ToolCard } from "../components/ToolCard";
import { MarkdownLite } from "../components/Markdown";
import { DesktopBanner } from "../components/DesktopBanner";

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  waiting_approval: "等待审批",
  done: "已完成",
  error: "出错",
  idle: "空闲",
};

/** 会话页（任务 7.4/7.5）：动作条常显 + 流式 + 工具卡片 + 审批 + 排队 + 滚动跟随 */
export function Session() {
  const { sessionId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [queue, setQueue] = useState(0);
  const [input, setInput] = useState("");
  const [busyError, setBusyError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState(new Map<string, { req: PendingApprovalUI; resolved: { decision: string } | null }>());
  const [liveStatus, setLiveStatus] = useState<{ status: string; activity: string | null } | null>(null);
  const [takenOver, setTakenOver] = useState(false);

  const detailQ = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.sessionDetail(sessionId),
  });

  // 进入时：桌面持有 → observe（实时观察）；否则普通恢复（desktopGone 后可直接接）
  const summary = detailQ.data?.session;
  useEffect(() => {
    if (!summary) return;
    if (summary.activeElsewhere && !summary.desktopGone) {
      api
        .observe(sessionId)
        .then(() => setBusyError(null))
        .catch((e) => {
          if ((e as { code?: string }).code === "IPC_OWNER_NOT_FOUND") {
            setBusyError("找不到会话拥有者（桌面端可能刚关闭）");
          } else {
            setBusyError(null);
          }
        });
      return;
    }
    api
      .resume(sessionId)
      .then(() => setBusyError(null))
      .catch((e) => {
        if ((e as { code?: string }).code === "SESSION_BUSY") {
          setBusyError("会话正在电脑上使用中（IDE / Codex Desktop 占用），先关掉再接管");
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, summary?.id, summary?.activeElsewhere, summary?.desktopGone]);

  // WS 订阅：事件驱动更新
  useEffect(() => {
    ws.onSnapshotRequired = (sid) => {
      if (sid === sessionId) queryClient.invalidateQueries({ queryKey: ["session", sid] });
    };
    return ws.subscribe(sessionId, (e: SessionEvent) => applyEvent(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, queryClient]);

  function applyEvent(e: SessionEvent) {
    if (e.type === "session.status") {
      setLiveStatus({ status: e.status, activity: e.activity });
      queryClient.setQueryData(["sessions"], (old: { sessions: Array<{ id: string; status: string }> } | undefined) => {
        if (!old) return old;
        return {
          sessions: old.sessions.map((s) => (s.id === sessionId ? { ...s, status: e.status } : s)),
        };
      });
      return;
    }
    if (e.type === "session.queue") {
      setQueue(e.queued);
      return;
    }
    if (e.type === "approval.request") {
      setApprovals((prev) => {
        const next = new Map(prev);
        next.set(e.approvalId, {
          req: {
            approvalId: e.approvalId,
            kind: e.kind,
            command: e.command,
            cwd: e.cwd,
            reason: e.reason,
            availableDecisions: e.availableDecisions,
          },
          resolved: null,
        });
        return next;
      });
      if (search.get("approval") !== e.approvalId) {
        // 新审批且用户未在看本会话横幅时静默；首页横幅由 sessions 数据驱动
      }
      return;
    }
    if (e.type === "approval.resolved") {
      setApprovals((prev) => {
        const cur = prev.get(e.approvalId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(e.approvalId, { ...cur, resolved: { decision: e.decision } });
        return next;
      });
      return;
    }
    if (e.type === "agent.delta") {
      setLiveStatus((s) => s ?? { status: "running", activity: null });
      // 流式文本：追加到临时缓冲（agent.message 到达时由快照替换）
      setDelta((d) =>
        d && d.itemId === e.itemId ? { itemId: d.itemId, text: d.text + e.delta } : { itemId: e.itemId, text: e.delta },
      );
      return;
    }
    if (e.type === "agent.message") {
      setDelta(null);
    }
    if (e.type === "user.message" || e.type === "agent.message" || e.type === "tool.started" || e.type === "tool.finished") {
      queryClient.setQueryData(["session", sessionId], (old: { session: { history: never[] } } | undefined) => {
        if (!old) return old;
        return { session: { ...old.session, history: applyEventToHistory(old.session.history, e) } };
      });
    }
  }

  const [delta, setDelta] = useState<{ itemId: string; text: string } | null>(null);

  const session = detailQ.data?.session;
  const status = liveStatus?.status ?? session?.status ?? "idle";
  const activity = liveStatus?.activity ?? null;
  const isDesktopBusy = !!session?.activeElsewhere && !session?.desktopGone;
  const canDrive = !isDesktopBusy || takenOver;

  // 滚动跟随
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setFollow(atBottom);
    followState.following = atBottom;
  }

  // 深链定位审批卡片
  useEffect(() => {
    const target = search.get("approval");
    if (target) {
      const el = document.getElementById(`approval-${target}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setSearch({}, { replace: true });
      }
    }
  }, [search, setSearch, approvals.size]);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      await api.sendMessage(sessionId, text);
    } catch {
      setInput(text); // 失败还原输入
    }
  }

  const history = useMemo(() => session?.history ?? [], [session]);
  const approvalList = [...approvals.entries()];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <div className="topbar">
        <Link to="/" className="back">
          ‹
        </Link>
        <div className="title">
          <div className="name">
            <span className={`dot ${status === "waiting_approval" ? "waiting" : status}`} />
            <i className="hash">#</i>
            <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session?.title ?? "会话"}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700, color: "var(--text-dim)", border: "1px solid rgba(34,28,14,.55)", padding: "1px 6px", borderRadius: 6 }}>CODEX</span>
          </div>
          <div className="sub">{session?.cwd}</div>
        </div>
        {(status === "running" || status === "waiting_approval") && (
          <div className="icon-btn" title="中断" onClick={() => api.interrupt(sessionId).catch(() => {})}>
            ⏹
          </div>
        )}
      </div>

      {busyError && (
        <div style={{ background: "var(--red-bg)", borderBottom: "1.5px solid var(--border)", padding: "10px 16px", fontSize: 12.5, color: "var(--red)", display: "flex", gap: 8, alignItems: "center" }}>
          <span>⏳</span>
          <span style={{ flex: 1 }}>{busyError}</span>
          <Link to="/" style={{ color: "var(--red)", fontWeight: 700, textDecoration: "underline dotted" }}>返回列表</Link>
        </div>
      )}

      {/* 桌面会话：观察/接管/兜底/谱系横幅（任务 5.1-5.3） */}
      <DesktopBanner
        sessionId={sessionId}
        activeElsewhere={!!session?.activeElsewhere}
        activeVia={session?.activeVia ?? null}
        desktopGone={!!session?.desktopGone}
        takenOver={takenOver}
        forkedFromId={session?.forkedFromId ?? null}
        forkedToId={session?.forkedToId ?? null}
        onTakenOver={() => setTakenOver(true)}
        onForked={(newId) => {
          queryClient.invalidateQueries({ queryKey: ["sessions"] });
          navigate(`/${newId}`);
        }}
      />

      {/* 动作条：当前动作常显 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px",
          fontSize: 12,
          fontWeight: status === "waiting_approval" ? 550 : 400,
          borderBottom: "1.5px solid var(--border)",
          background: status === "waiting_approval" ? "var(--gold)" : "var(--surface)",
          color: "var(--text)",
          flexShrink: 0,
        }}
      >
        <span className={`dot ${status === "waiting_approval" ? "waiting" : status}`} />
        <span>{status === "waiting_approval" ? "等待批准" : STATUS_LABEL[status]}</span>
        {activity && <span className="mono-cmd">{activity}</span>}
        {queue > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>· {queue} 条排队</span>}
      </div>

      {/* 对话流 */}
      <div className="content" ref={scrollRef} onScroll={onScroll}>
        {history.map((h) => {
          if (h.type === "userMessage") {
            return (
              <div
                key={h.id}
                style={{
                  alignSelf: "flex-end",
                  maxWidth: "82%",
                  background: "var(--gold)",
                  border: "1.5px solid var(--border)",
                  boxShadow: "3px 3px 0 var(--border)",
                  padding: "10px 14px",
                  borderRadius: "16px 16px 6px 16px",
                  margin: "14px 4px 0 auto",
                  fontSize: 14,
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap",
                  width: "fit-content",
                  marginLeft: "auto",
                  display: "block",
                }}
              >
                {h.text}
              </div>
            );
          }
          if (h.type === "agentMessage") {
            return (
              <div key={h.id} style={{ fontSize: 14, lineHeight: 1.75, margin: "14px 2px 0" }}>
                <MarkdownLite text={h.text} />
              </div>
            );
          }
          if (h.type === "toolCall") return <ToolCard key={h.id} item={h} />;
          return null;
        })}

        {/* 流式缓冲 */}
        {delta && (
          <div style={{ fontSize: 14, lineHeight: 1.75, margin: "14px 2px 0" }}>
            <MarkdownLite text={delta.text} />
            <span style={{ display: "inline-block", width: 8, height: 15, background: "var(--gold-deep)", border: "1px solid var(--border)", verticalAlign: -2, marginLeft: 3, animation: "pulse 1s infinite" }} />
          </div>
        )}

        {/* 审批卡片（插入对话流末尾，按到达顺序） */}
        {approvalList.map(([id, a]) => (
          <ApprovalCard
            key={id}
            a={a.req}
            sessionId={sessionId}
            resolved={a.resolved}
            onResolved={(approvalId, decision) =>
              setApprovals((prev) => {
                const cur = prev.get(approvalId);
                if (!cur) return prev;
                const next = new Map(prev);
                next.set(approvalId, { ...cur, resolved: { decision } });
                return next;
              })
            }
          />
        ))}

        {detailQ.isError && <div className="empty-note">会话加载失败</div>}
      </div>

      {!follow && (
        <div
          onClick={() => {
            setFollow(true);
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }}
          style={{ position: "absolute", bottom: 110, left: "50%", transform: "translateX(-50%)", background: "var(--border)", color: "#fff3c4", fontFamily: "var(--mono)", fontSize: 11.5, padding: "8px 16px", borderRadius: 99, border: "1.5px solid var(--border)", boxShadow: "3px 3px 0 var(--gold)", zIndex: 20 }}
        >
          ↓ 回到底部
        </div>
      )}

      {/* 输入栏 */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "10px 14px 14px",
          background: "linear-gradient(180deg, transparent, var(--bg) 30%)",
          display: "flex",
          gap: 9,
          alignItems: "flex-end",
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={!canDrive}
          placeholder={
            !canDrive
              ? "观察模式 · 点上方「接管此会话」后可发指令"
              : status === "running" || status === "waiting_approval"
                ? "发送消息…（运行中将排队）"
                : "发送消息…"
          }
          style={{
            flex: 1,
            background: "var(--surface)",
            border: "1.5px solid var(--border)",
            boxShadow: "2px 2px 0 var(--border)",
            borderRadius: 14,
            padding: "11px 13px",
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          className="btn"
          style={{ width: 46, height: 42, flexShrink: 0, padding: 0 }}
          disabled={!input.trim()}
          onClick={send}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
