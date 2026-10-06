import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../runtime";

/**
 * 桌面会话横幅（任务 5.1/5.2/5.3）：
 * 观察/接管/桌面已关闭/接力兜底/谱系提示 的统一入口。
 */
export function DesktopBanner(props: {
  sessionId: string;
  activeElsewhere: boolean;
  activeVia: string | null;
  desktopGone: boolean;
  takenOver: boolean;
  forkedFromId: string | null;
  forkedToId: string | null;
  onTakenOver: () => void;
  onForked?: (newSessionId: string) => void;
}) {
  const { sessionId, activeElsewhere, activeVia, desktopGone, takenOver, forkedFromId, forkedToId, onTakenOver, onForked } = props;
  const [busy, setBusy] = useState(false);
  const [ipcFailed, setIpcFailed] = useState(false);
  const [forking, setForking] = useState(false);

  // 已接管：不显示横幅（正常驾驶中）
  if (takenOver) {
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

  // 桌面已关闭：可直接接管（普通恢复）
  if (desktopGone || !activeElsewhere) return null;

  async function handleTakeover() {
    setBusy(true);
    try {
      await api.takeover(sessionId);
      onTakenOver();
    } catch (e) {
      if (String(e).includes("IPC_OWNER_NOT_FOUND") || (e as { code?: string }).code === "IPC_OWNER_NOT_FOUND") {
        setIpcFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleFork() {
    setForking(true);
    try {
      const res = await api.fork(sessionId);
      onForked?.(res.id);
    } finally {
      setForking(false);
    }
  }

  if (ipcFailed) {
    return (
      <div style={{ ...banner, background: "var(--red-bg)", color: "var(--red)" }}>
        <span>⚠️ 委托通道不可用（找不到会话拥有者）</span>
        <button
          className="btn ghost"
          style={{ height: 32, borderRadius: 9, boxShadow: "2px 2px 0 var(--border)", fontSize: 12.5 }}
          disabled={forking}
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
        ⏳ {activeVia ?? "电脑"}运行中 · 实时观察已连接
      </span>
      <button
        className="btn"
        style={{ height: 32, borderRadius: 9, boxShadow: "2px 2px 0 var(--border)", fontSize: 12.5 }}
        disabled={busy}
        onClick={handleTakeover}
      >
        {busy ? "接管中…" : "接管此会话"}
      </button>
    </div>
  );
}

const banner: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 16px",
  borderBottom: "1.5px solid var(--border)",
  fontSize: 12.5,
  fontWeight: 550,
  flexShrink: 0,
};

const hint: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 11.5,
  color: "var(--text-faint)",
  fontFamily: "var(--mono)",
  borderBottom: "1px dotted var(--border-soft)",
};
