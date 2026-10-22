import { useCallback, useEffect, useRef, useState } from "react";
import type { PushConfigResponse } from "@agentlink/shared";
import { api } from "../runtime";
import { disablePush, enablePush, inspectPush, pushDeviceId, pushPermission, pushSupportError } from "../push-client";

export function PushSettings() {
  const [support] = useState(pushSupportError);
  const [state, setState] = useState<(PushConfigResponse & { active: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (support) return;
    const current = ++generation.current;
    try { const next = await inspectPush(); if (current === generation.current) { setState(next); setError(null); } }
    catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : "无法读取通知状态"); }
  }, [support]);
  useEffect(() => {
    void load();
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { generation.current++; document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  async function change() {
    if (!state || busy) return;
    generation.current++;
    setBusy(true); setError(null); setNote(null);
    try {
      if (state.active || state.device) { await disablePush(); setState({ ...state, active: false, device: null }); setNote("已关闭此设备的任务通知"); }
      else { setState(await enablePush(state.publicKey, { renew: !!pushDeviceId() })); setNote("通知订阅已开启，请发送测试通知并确认手机实际收到。"); }
    } catch (e) { setError(e instanceof Error ? e.message : "通知设置失败，请重试"); }
    finally { setBusy(false); }
  }
  async function test() {
    if (!state?.device || busy) return;
    generation.current++;
    setBusy(true); setError(null); setNote(null);
    try {
      const result = await api.pushTest(state.device.id);
      setState({ ...state, device: result.device, active: !!result.device });
      setNote(!result.device ? "通知订阅已失效，请重新开启。" : result.device.pending > 0 ? "测试通知正在等待重试，请检查手机通知栏。" : "推送服务已接受测试通知，请确认手机通知栏是否收到。");
    } catch (e) { setError(e instanceof Error ? e.message : "测试通知发送失败，请重试"); }
    finally { setBusy(false); }
  }

  return <>
    <div className="section-label">任务通知</div>
    <div className="card" style={{ cursor: "default", fontSize: 13, lineHeight: 1.7 }}>
      <div>任务本轮完成或出错时，通过系统通知提醒；点击通知返回原会话。</div>
      <div style={{ color: "var(--text-dim)", fontSize: 12 }}>手机页面关闭后仍可接收，电脑上的 AgentLink 后台需要保持运行。</div>
      <div role="status" style={{ marginTop: 8 }}>
        {support ?? (busy ? "正在处理通知设置…" : state?.active ? "此设备已开启任务通知" : state?.device ? "订阅需要更新，请先关闭后重新开启" : "此设备尚未开启任务通知")}
      </div>
      {!support && pushPermission() === "denied" && <div style={{ color: "var(--amber)" }}>通知权限已被拒绝，请在浏览器或系统设置中允许通知。</div>}
      {state?.device?.lastAcceptedAt && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>推送服务最近接受：{new Date(state.device.lastAcceptedAt).toLocaleString()}（不代表手机已收到）</div>}
      {state?.device?.lastError && <div style={{ color: "var(--amber)" }}>{state.device.lastError}</div>}
      {note && <div role="status">{note}</div>}
      {error && <div role="alert" style={{ color: "var(--red)" }}>{error}</div>}
      {!support && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <button className="btn" style={{ padding: "0 12px" }} disabled={busy || !state} onClick={() => { void change(); }}>{state?.active || state?.device ? "关闭任务通知" : "开启任务通知"}</button>
        <button className="btn ghost" style={{ padding: "0 12px" }} disabled={busy || !state?.active} onClick={() => { void test(); }}>发送测试通知</button>
        <button className="btn ghost" style={{ padding: "0 12px" }} disabled={busy} onClick={() => { void load(); }}>重新检查</button>
      </div>}
      <div style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 8 }}>首次请实际测试锁屏和关闭页面后的通知。系统省电、浏览器推送服务及网络会影响送达。</div>
    </div>
  </>;
}
