import { useState } from "react";
import { Link } from "react-router-dom";
import type { AuditEntry } from "@agentlink/shared";
import { api } from "../runtime";

/** 审计日志（任务 7.7）：分页倒序 */
export function Audit() {
  const [pages, setPages] = useState<AuditEntry[][]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await api.audit(cursor, 50);
      setPages((p) => [...p, res.entries]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }

  if (!loaded && !loading) void load();
  const entries = pages.flat();
  const decisionLabel: Record<string, string> = {
    accept: "批准",
    acceptForSession: "批准（本会话）",
    decline: "拒绝",
    cancel: "拒绝并中断",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <div className="topbar">
        <Link to="/settings" className="back">‹</Link>
        <div className="title"><div className="name">审计日志</div></div>
      </div>
      <div className="content">
        <div className="card" style={{ cursor: "default" }}>
          {entries.length === 0 && !loading && <div className="empty-note">还没有审批记录</div>}
          {entries.map((e) => (
            <div key={e.id} style={{ padding: "12px 0", borderBottom: "1px dotted #dacfaf", fontSize: 13 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: e.decision.startsWith("accept") ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
                  {decisionLabel[e.decision] ?? e.decision}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{e.project.split(/[\\/]/).pop()}</span>
                <span style={{ fontSize: 11, color: "var(--text-faint)", marginLeft: "auto", fontFamily: "var(--mono)" }}>
                  {new Date(e.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {e.command && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)", background: "var(--surface-2)", border: "1px dashed #d9cdaa", borderRadius: 6, padding: "5px 8px", marginTop: 7, wordBreak: "break-all" }}>
                  {e.command}
                </div>
              )}
            </div>
          ))}
          {cursor && (
            <div style={{ textAlign: "center", padding: "12px 0", fontSize: 13, color: "var(--text-dim)", cursor: loading ? "default" : "pointer", textDecoration: "underline dotted" }} onClick={() => !loading && load()}>
              {loading ? "加载中…" : "加载更多"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
