import { useEffect, useState } from "react";
import { native, serverBase, type NativeStatus } from "../native";
import { useStore } from "../store";

export function NativePushSettings() {
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { try { setStatus(await native.status()); } catch { setError("无法读取安卓通知服务状态"); } }
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 5000); return () => clearInterval(t); }, []);
  async function change() {
    setBusy(true); setError(""); setNote("");
    try {
      setStatus(status?.enabled ? await native.stop() : await native.start({ url: serverBase(), token: useStore.getState().token! }));
    } catch (e) { setError(e instanceof Error ? e.message : "无法更改通知设置"); }
    finally { setBusy(false); }
  }
  return <>
    <div className="section-label">安卓任务通知</div>
    <div className="card" style={{ cursor: "default", fontSize: 13, lineHeight: 1.7 }}>
      <div>关闭聊天界面后，由安卓服务接收任务完成或出错通知；点击返回原会话。</div>
      <div role="status">{status?.enabled && !status.running ? "后台服务未运行，请关闭后重新开启" : status?.state ?? "正在读取…"}</div>
      {status?.enabled && !status.permission && <div role="alert">通知权限已关闭，请在系统应用设置中允许通知。</div>}
      {status?.lastDeliveredAt ? <div>最近展示通知：{new Date(status.lastDeliveredAt).toLocaleString()}</div> : null}
      {status?.enabled && !status.batteryExempt && <div>请允许后台运行，并在小米系统中开启自启动、将省电策略设为不限制。</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <button className="btn" style={{ padding: "0 12px" }} disabled={busy || !status} onClick={() => { void change(); }}>{status?.enabled ? "关闭任务通知" : "开启任务通知"}</button>
        <button className="btn ghost" style={{ padding: "0 12px" }} disabled={busy || !status?.enabled} onClick={async () => { try { await native.test(); setNote("测试通知已入队，请检查通知栏；这不代表手机已经展示。"); } catch { setError("测试失败，请检查后台连接"); } }}>测试通知</button>
        <button className="btn ghost" style={{ padding: "0 12px" }} onClick={async () => { try { await native.batterySettings(); } catch { setError("请手动打开系统中的 AgentLink 应用设置"); } }}>后台运行设置</button>
      </div>
      {error && <div role="alert">{error}</div>}{note && <div role="status">{note}</div>}
      <div style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 12 }}>需要电脑后台保持运行。首次请实测锁屏、切换网络及长时间待机；强制停止应用会断开通知连接。</div>
    </div>
  </>;
}
