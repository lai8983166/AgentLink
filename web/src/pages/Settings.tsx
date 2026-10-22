import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../runtime";
import { useStore } from "../store";
import { applyAppUpdate, checkAppUpdate, useAppUpdate } from "../app-updater";
import { KeyboardDiagnostics } from "../components/KeyboardDiagnostics";
import { PushSettings } from "../components/PushSettings";
import { disablePush, pushDeviceId } from "../push-client";
import { useState } from "react";
import { isAndroidApp, native, serverBase } from "../native";
import { NativePushSettings } from "../components/NativePushSettings";

/** 设置页（任务 7.7）：连接状态 / 通知说明 / 审计入口 / 解除配对 */
export function Settings() {
  const update = useAppUpdate();
  const clearToken = useStore((s) => s.clearToken);
  const wsConnected = useStore((s) => s.wsConnected);
  const statusQ = useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 15000 });
  const [unpairError, setUnpairError] = useState<string | null>(null);

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

        <div className="section-label">应用版本</div>
        <div className="card" style={{ cursor: "default", fontSize: 12, lineHeight: 1.7 }}>
          <div>当前前端版本：<span data-testid="app-build">{update.build}</span></div>
          <div style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>访问地址：{serverBase() || location.origin}</div>
          {isAndroidApp() ? <div>APK 内置界面，更新请安装新版 APK。</div> : <>
          <div style={{ color: "var(--text-dim)" }}>浏览器和桌面入口可在此核对版本与地址。</div>
          <div role="status" style={{ margin: "8px 0" }}>
            {update.applying ? "正在更新页面…" : update.checking ? "检查更新中…" : update.error ??
              (update.available ? "有新版本可用，更新会重新加载页面" : update.checked ? "当前已是最新版本" : "尚未检查更新")}
          </div>
          </>}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn ghost" style={{ flex: 1 }} disabled={update.checking || update.applying} onClick={() => { void checkAppUpdate(); }}>检查更新</button>
            {update.available && <button className="btn" style={{ flex: 1 }} disabled={update.checking || update.applying} onClick={() => { void applyAppUpdate(); }}>更新页面</button>}
          </div>
        </div>

        <KeyboardDiagnostics />
        {isAndroidApp() ? <NativePushSettings /> : <PushSettings />}

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
          onClick={async () => {
            if (!confirm("解除配对并清除此设备上的 token？")) return;
            try { if (isAndroidApp()) await native.stop(); else if (pushDeviceId()) await disablePush(); clearToken(); }
            catch { setUnpairError("未能关闭此设备的通知，请联网后重试解除配对。"); }
          }}
        >
          解除配对
        </div>
        {unpairError && <div role="alert">{unpairError}</div>}

        <div className="empty-note">AgentLink v0.1</div>
      </div>
    </div>
  );
}
