import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionDetailResponse, SessionEvent } from "@agentlink/shared";
import { api, ws } from "../runtime";
import { followState, useStore } from "../store";
import { ApprovalCard, type PendingApprovalUI } from "../components/ApprovalCard";
import { ToolCard } from "../components/ToolCard";
import { MarkdownLite } from "../components/Markdown";
import { DesktopBanner } from "../components/DesktopBanner";
import { applySessionEvent, mergeSessionDetail } from "../session-state";
import { useMessageOutbox } from "../message-outbox";
import { mergeOutgoingHistory } from "../message-history";
import { useVisibleViewport } from "../visible-viewport";
import { UpdateNotice } from "../components/UpdateNotice";

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  waiting_approval: "等待审批",
  done: "已完成",
  error: "出错",
  idle: "空闲",
  unknown: "状态待确认",
};

/** 会话页（任务 7.4/7.5）：动作条常显 + 流式 + 工具卡片 + 审批 + 排队 + 滚动跟随 */
export function Session() {
  const { sessionId } = useParams();
  return <SessionView key={sessionId} />;
}

function SessionView() {
  const viewportStyle = useVisibleViewport();
  const { sessionId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [queue, setQueue] = useState(0);
  const { input, setInput, messages, sending, notice, uncertain, submit, recheck } = useMessageOutbox(sessionId, {
    history: () => queryClient.getQueryData<SessionDetailResponse>(["session", sessionId])?.session.history ?? [],
    onAccepted: () => { queryClient.invalidateQueries({ queryKey: ["session", sessionId] }); },
  });
  const wsConnected = useStore((s) => s.wsConnected);
  const [interrupting, setInterrupting] = useState(false);
  const [busyError, setBusyError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState(new Map<string, { req: PendingApprovalUI; resolved: { decision: string } | null }>());
  const [liveStatus, setLiveStatus] = useState<{ status: string; activity: string | null } | null>(null);
  const [takenOverId, setTakenOverId] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const eventBacklog = useRef<SessionEvent[]>([]);

  const detailQ = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async () => {
      const incoming = await api.sessionDetail(sessionId);
      let result = mergeSessionDetail(queryClient.getQueryData<SessionDetailResponse>(["session", sessionId]), incoming);
      for (const e of eventBacklog.current) result = applySessionEvent(result, e) ?? result;
      return result;
    },
    refetchOnMount: "always",
  });
  const takenOver = detailQ.data?.session.controlMode === "takeover" ||
    (detailQ.data?.session.controlMode === undefined && takenOverId === sessionId);

  useEffect(() => {
    const snapshot = detailQ.data?.session.approvals;
    if (!snapshot) return;
    setApprovals((previous) => {
      const next = new Map([...previous].filter(([id, a]) => a.resolved || snapshot.some((p) => p.approvalId === id)));
      for (const req of snapshot) next.set(req.approvalId, { req, resolved: null });
      return next;
    });
  }, [detailQ.data?.session.approvals]);

  // 桌面原会话只走 observe；占用标记变化/失联时也不能自动 resume 抢写权。
  // 摘要来源：优先列表缓存（首页已拉过，快）——detail 走 rollout 首拉可达 30s，
  // 先行 observe 让基准快照尽早落地，history.sync 到达即重拉 detail（快照直出，快）
  const summary =
    detailQ.data?.session ??
    queryClient
      .getQueryData<{ sessions: Array<{ id: string; activeElsewhere: boolean; desktopGone: boolean; desktopManaged?: boolean }> }>(["sessions"])
      ?.sessions.find((s) => s.id === sessionId);
  useEffect(() => {
    if (!summary) return;
    if (summary.desktopManaged || summary.activeElsewhere || takenOver) {
      api
        .observe(sessionId)
        .then(() => setBusyError(null))
        .catch((e) => {
          if ((e as { code?: string }).code === "IPC_OWNER_NOT_FOUND") {
            setBusyError("电脑端连接不可用，请在 Codex 中打开原会话后重试");
          } else {
            setBusyError(e instanceof Error ? e.message : "电脑端连接失败，请重试");
          }
        });
      return;
    }
    api
      .resume(sessionId)
      .then(() => setBusyError(null))
      .catch((e) => {
        if ((e as { code?: string }).code === "SESSION_BUSY") {
          // 占用检测是 5 分钟启发式，实际拥有者可能还在（对话开着但闲置）→ 转观察模式
          api
            .observe(sessionId)
            .then(() => setBusyError(null))
            .catch(() =>
              setBusyError("电脑端连接不可用，请在 Codex 中打开原会话后重试"),
            );
        } else setBusyError(e instanceof Error ? e.message : "会话连接失败，请重试");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, summary?.id, summary?.desktopManaged, summary?.activeElsewhere, takenOver]);

  // WS 订阅：事件驱动更新
  useEffect(() => {
    return ws.subscribe(sessionId, (e: SessionEvent) => applyEvent(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, queryClient]);

  function applyEvent(e: SessionEvent) {
    const cached = queryClient.getQueryData<SessionDetailResponse>(["session", sessionId]);
    if (cached && e.seq <= cached.latestSeq) return;
    if (!cached) eventBacklog.current = [...eventBacklog.current, e].slice(-500);
    queryClient.setQueryData<SessionDetailResponse>(["session", sessionId], (old) => applySessionEvent(old, e));
    if (e.type === "session.status") {
      setLiveStatus({ status: e.status, activity: e.activity });
      queryClient.setQueryData(["sessions"], (old: { sessions: Array<{ id: string; status: string }> } | undefined) => {
        if (!old) return old;
        return {
          sessions: old.sessions.map((s) => (s.id === sessionId ? { ...s, status: e.status, statusUpdatedAt: e.at } : s)),
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
    if (e.type === "error") {
      setErrorBanner(e.message);
      return;
    }
    if (e.type === "history.sync") {
      // 权威历史已重建（基准快照落位）：重拉 detail，收敛增量丢失造成的部分文本
      queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
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
  }

  const [delta, setDelta] = useState<{ itemId: string; text: string } | null>(null);

  const session = detailQ.data?.session;
  const status = session?.status ?? liveStatus?.status ?? "unknown";
  const activity = liveStatus?.activity ?? null;
  const isDesktopBusy = !!session?.desktopManaged || (!!session?.activeElsewhere && !session?.desktopGone);
  const canDrive = !isDesktopBusy || (takenOver && !session?.desktopGone && status !== "unknown");

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
    if (canDrive && !sending) await submit();
  }

  const history = useMemo(() => mergeOutgoingHistory(session?.history ?? [], messages), [session?.history, messages]);
  const approvalList = [...approvals.entries()];

  return (
    <div className="session-page" style={viewportStyle}>
      <div className="session-header">
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
          <button className="icon-btn" title="中断" disabled={!canDrive || interrupting} onClick={async () => {
            setInterrupting(true);
            try { await api.interrupt(sessionId); }
            catch (e) { setErrorBanner(e instanceof Error ? e.message : "中断失败，请重试"); }
            finally { setInterrupting(false); }
          }}>
            ⏹
          </button>
        )}
      </div>

      <UpdateNotice />
      {busyError && (
        <div style={{ background: "var(--red-bg)", borderBottom: "1.5px solid var(--border)", padding: "10px 16px", fontSize: 12.5, color: "var(--red)", display: "flex", gap: 8, alignItems: "center" }}>
          <span>⏳</span>
          <span style={{ flex: 1 }}>{busyError}</span>
          <Link to="/" style={{ color: "var(--red)", fontWeight: 700, textDecoration: "underline dotted" }}>返回列表</Link>
        </div>
      )}

      {errorBanner && (
        <div style={{ background: "var(--red-bg)", borderBottom: "1.5px solid var(--border)", padding: "10px 16px", fontSize: 12.5, color: "var(--red)", display: "flex", gap: 8, alignItems: "center" }}>
          <span>⚠️</span>
          <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11.5, wordBreak: "break-all" }}>{errorBanner}</span>
          <span style={{ cursor: "pointer", fontWeight: 700 }} onClick={() => setErrorBanner(null)}>✕</span>
        </div>
      )}

      {/* 桌面会话：观察/接管/兜底/谱系横幅（任务 5.1-5.3） */}
      <DesktopBanner
        key={sessionId}
        sessionId={sessionId}
        activeElsewhere={!!session?.activeElsewhere}
        activeVia={session?.activeVia ?? null}
        desktopGone={!!session?.desktopGone}
        desktopManaged={!!session?.desktopManaged}
        takenOver={takenOver}
        forkedFromId={session?.forkedFromId ?? null}
        forkedToId={session?.forkedToId ?? null}
        onTakenOver={() => {
          setTakenOverId(sessionId);
          queryClient.setQueryData<SessionDetailResponse>(["session", sessionId], (old) => old && ({
            ...old, session: { ...old.session, controlMode: "takeover" },
          }));
          queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        }}
        onForked={(newId) => {
          queryClient.invalidateQueries({ queryKey: ["sessions"] });
          navigate(`/${newId}`);
        }}
      />

      {/* 动作条：当前动作常显 */}
      <div style={{ padding: "4px 16px", fontSize: 11, color: "var(--text-dim)" }}>
        {wsConnected ? "手机与后台已连接" : "手机与后台连接中"}
        {session?.desktopManaged && ` · ${session.desktopGone ? "电脑端未连接" : status === "unknown" ? "会话状态待确认" : takenOver ? "原会话可控制" : "原会话观察中"}`}
        {session?.statusUpdatedAt ? ` · 同步于 ${new Date(session.statusUpdatedAt).toLocaleTimeString()}` : ""}
      </div>
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

      </div>
      {/* 对话流 */}
      <div className="conversation-area">
      <div className="content session-content" data-testid="conversation-history" ref={scrollRef} onScroll={onScroll}>
        {history.map((h) => {
          if (h.type === "userMessage") {
            return (
              <div
                key={h.id}
                data-message-id={h.id}
                data-message-type="user"
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
                {h.deliveryState && <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 4 }}>
                  {{ sending: "发送中", accepted: "电脑端已接收 · 等待同步", failed: "发送失败 · 草稿已保留", uncertain: "接收结果待确认" }[h.deliveryState]}
                </div>}
              </div>
            );
          }
          if (h.type === "agentMessage") {
            return (
              <div key={h.id} data-message-id={h.id} data-message-type="agent" style={{ fontSize: 14, lineHeight: 1.75, margin: "14px 2px 0" }}>
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
          style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", background: "var(--border)", color: "#fff3c4", fontFamily: "var(--mono)", fontSize: 11.5, padding: "8px 16px", borderRadius: 99, border: "1.5px solid var(--border)", boxShadow: "3px 3px 0 var(--gold)", zIndex: 20 }}
        >
          ↓ 回到底部
        </div>
      )}
      </div>

      {/* 输入栏 */}
      {notice && <div role="status" className="composer-notice">
        {notice} {uncertain && <button onClick={recheck}>核对发送结果</button>}
      </div>}
      <div
        className="composer"
        style={{
          display: "flex",
          gap: 9,
          alignItems: "flex-end",
        }}
      >
        <input
          aria-label="消息指令"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send()}
          disabled={!canDrive || sending}
          placeholder={
            !canDrive
              ? "观察模式 · 点上方「接管此会话」后可发指令"
              : status === "running" || status === "waiting_approval"
                ? "发送消息…（运行中将排队）"
                : "发送消息…"
          }
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--surface)",
            border: "1.5px solid var(--border)",
            boxShadow: "2px 2px 0 var(--border)",
            borderRadius: 14,
            padding: "11px 13px",
            fontSize: 16,
            outline: "none",
          }}
        />
        <button
          className="btn"
          style={{ width: 46, height: 42, flexShrink: 0, padding: 0 }}
          disabled={!input.trim() || !canDrive || sending || uncertain}
          onClick={send}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
