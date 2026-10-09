import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../runtime";
import type { SessionDetailResponse } from "@agentlink/shared";

/**
 * 桌面会话横幅（任务 5.1/5.2/5.3）：
 * 观察/接管/桌面已关闭/接力兜底/谱系提示 的统一入口。
 */
export function DesktopBanner(props: {
  sessionId: string;
  activeElsewhere: boolean;
  activeVia: string | null;
  desktopGone: boolean;
  desktopManaged?: boolean;
  takenOver: boolean;
  forkedFromId: string | null;
  forkedToId: string | null;
  onTakenOver: () => void;
  onResumed?: (detail: SessionDetailResponse) => void;
  onForked?: (newSessionId: string) => void;
}) {
  const { sessionId, activeElsewhere, activeVia, desktopGone, desktopManaged, takenOver, forkedFromId, forkedToId, onTakenOver, onResumed, onForked } = props;
  const [busy, setBusy] = useState(false);
  const [ipcFailed, setIpcFailed] = useState(false);
  const [forking, setForking] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已接管：不显示横幅（正常驾驶中）
  if (takenOver && !desktopGone) {
    return forkedFromId ? (
      <div style={hint}>
        <span>🧬 此会话从 <i className="hash">#</i>{forkedFromId.slice(0, 8)} 接力而来（历史完整继承）</span>
      </div>
    ) : null;
  }

  // 谱系：旧会话存在更新后代 → 引导直达
  if (forkedToId) {
    return (
      <div style={{ ...banner, background: "var(--blue-bg)", color: "#2c47c4" }}>
        <span>🧬 此会话已接力至新会话，最新进展在那里</span>
        <Link to={`/${forkedToId}`} style={{ fontWeight: 700, color: "#2c47c4", textDecoration: "underline dotted" }}>
          打开 →
        </Link>
      </div>
    );
  }

  if (!desktopManaged && (desktopGone || !activeElsewhere)) return null;

  async function handleTakeover() {
    setBusy(true);
    setError(null);
    try {
      await api.takeover(sessionId);
      onTakenOver();
    } catch (e) {
      setError(e instanceof Error ? e.message : "接管失败，请重试");
      if (String(e).includes("IPC_OWNER_NOT_FOUND") || (e as { code?: string }).code === "IPC_OWNER_NOT_FOUND") {
        setIpcFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleFork() {
    setForking(true);
    setError(null);
    try {
      const res = await api.fork(sessionId);
      onForked?.(res.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建接力会话失败，请重试");
    } finally {
      setForking(false);
    }
  }

  async function handleResume() {
    setResuming(true);
    setError(null);
    try {
      const result = await api.resume(sessionId);
      onResumed?.(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "恢复原会话失败，请稍后重试");
    } finally { setResuming(false); }
  }

  const resumeButton = onResumed && (
    <button className="btn" style={actionStyle} disabled={busy || forking || resuming} onClick={handleResume}>
      {resuming ? "检查并恢复中…" : "继续原会话"}
    </button>
  );

  if (ipcFailed) {
    return (
      <div style={{ ...banner, background: "var(--red-bg)", color: "var(--red)" }}>
        <span>⚠️ {error ?? "委托通道不可用（找不到会话拥有者）"}</span>
        {resumeButton}
        <button
          className="btn ghost"
          style={{ height: 32, borderRadius: 9, boxShadow: "2px 2px 0 var(--border)", fontSize: 12.5 }}
          disabled={busy || forking || resuming}
          onClick={handleFork}
        >
          {forking ? "接力中…" : "接力为新会话（继承全部历史）"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...banner, background: "var(--gold)", color: "var(--text)" }}>
      <span>
        ⏳ {error ?? (desktopGone ? "电脑端连接不可用；会话已关闭时，可继续原会话" : `${activeVia ?? "电脑端"}原会话 · 可观察或接管`)}
      </span>
      {resumeButton}
      <button
        className="btn"
        style={{ height: 32, borderRadius: 9, boxShadow: "2px 2px 0 var(--border)", fontSize: 12.5 }}
        disabled={busy || forking || resuming}
        onClick={handleTakeover}
      >
        {busy ? "接管中…" : "接管此会话"}
      </button>
    </div>
  );
}

const banner: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
  padding: "10px 16px",
  borderBottom: "1.5px solid var(--border)",
  fontSize: 12.5,
  fontWeight: 550,
  flexShrink: 0,
};

const actionStyle: React.CSSProperties = { height: 32, borderRadius: 9, boxShadow: "2px 2px 0 var(--border)", fontSize: 12.5 };

const hint: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 11.5,
  color: "var(--text-faint)",
  fontFamily: "var(--mono)",
  borderBottom: "1px dotted var(--border-soft)",
};
