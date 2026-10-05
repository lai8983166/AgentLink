import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../runtime";
import { useStore } from "../store";

/** 设置页（任务 7.7）：连接状态 / 通知说明 / 审计入口 / 解除配对 */
export function Settings() {
  const clearToken = useStore((s) => s.clearToken);
  const wsConnected = useStore((s) => s.wsConnected);
  const statusQ = useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 15000 });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <div className="topbar">
        <Link to="/" className="back">‹</Link>
        <div className="title"><div className="name">设置</div></div>
      </div>
      <div className="content">
        <div className="section-label" style={{ marginTop: 0 }}>连接</div>
        <div className="card" style={{ cursor: "default" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 14 }}>
            <span>🏠</span>
            <div style={{ flex: 1 }}>
              家里 PC
              <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
                daemon v{statusQ.data?.daemonVersion ?? "…"}
              </div>
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: wsConnected ? "var(--green)" : "var(--red)" }}>
              {wsConnected ? "已连接" : "未连接"}
            </span>
          </div>
        </div>
        <div className="card" style={{ cursor: "default" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 14 }}>
            <span>🛰</span>
            <div style={{ flex: 1 }}>
              接入模式
              <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
                {statusQ.data?.mode === "local" ? "本机" : statusQ.data?.mode === "relay" ? "VPS 中继" : "局域网"}
              </div>
            </div>
          </div>
        </div>

        <div className="section-label">通知（ntfy）</div>
        <div className="card" style={{ cursor: "default", fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
          通知经 ntfy App 推送（审批 / 完成 / 出错），在手机 ntfy 中订阅：
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, marginTop: 6, color: "var(--text)" }}>
            agentlink-approval<span style={{ color: "var(--text-faint)" }}>（最高优先级）</span>
            <br />
            agentlink-task
          </div>
          <div style={{ fontSize: 11.5, marginTop: 8, color: "var(--text-faint)" }}>
            开关在电脑端 ~/.agentlink/config.toml（[ntfy] enabled）
          </div>
        </div>

        <div className="section-label">安全</div>
        <Link to="/settings/audit" className="card" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 14 }}>
            <span>📋</span>
            <div style={{ flex: 1 }}>
              审计日志
              <div style={{ fontSize: 11, color: "var(--text-faint)" }}>你批准过的每一次操作</div>
            </div>
            <span style={{ color: "var(--text-faint)" }}>›</span>
          </div>
        </Link>

        <div className="section-label">设备</div>
        <div
          className="card"
          style={{ cursor: "pointer", color: "var(--red)", fontSize: 14 }}
          onClick={() => {
            if (confirm("解除配对并清除此设备上的 token？")) clearToken();
          }}
        >
          解除配对
        </div>

        <div className="empty-note">AgentLink v0.1</div>
      </div>
    </div>
  );
}
