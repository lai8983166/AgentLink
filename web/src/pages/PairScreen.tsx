import { useState } from "react";
import { useStore } from "../store";
import { useVisibleViewport } from "../visible-viewport";
import { isAndroidApp, normalizeServerUrl, serverBase, setServerBase } from "../native";

/** 首次配对：粘贴 daemon token（remote-access spec） */
export function PairScreen() {
  const viewportStyle = useVisibleViewport();
  const setToken = useStore((s) => s.setToken);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [server, setServer] = useState(serverBase);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!value.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const base = isAndroidApp() ? normalizeServerUrl(server) : "";
      const res = await fetch(`${base}/api/v1/status`, {
        headers: { Authorization: `Bearer ${value.trim()}` },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401) {
        setErr("token 无效，请检查电脑上 ~/.agentlink/config.toml");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (isAndroidApp()) setServerBase(base);
      setToken(value.trim());
    } catch (e) {
      setErr(`连不上 daemon：${e instanceof Error ? e.message : "未知错误"}`);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ ...viewportStyle, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, overflowY: "auto" }}>
      <div
        style={{
          background: "var(--surface)",
          border: "1.5px solid var(--border)",
          borderRadius: 16,
          boxShadow: "4px 4px 0 var(--border)",
          padding: 24,
          width: "100%",
          maxWidth: 360,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4 }}>
          <span className="logo" style={{ marginRight: 8 }} />
          AgentLink
        </div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 16, fontFamily: "var(--mono)" }}>
          // 粘贴电脑上的配对 token
        </div>
        {isAndroidApp() && <input aria-label="服务器地址" type="url" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://你的 AgentLink 地址" autoCapitalize="none" autoCorrect="off" style={{ width: "100%", padding: 12, fontSize: 16, marginBottom: 12 }} />}
        <input
          type="password"
          aria-label="配对 token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="agentlink token"
          style={{
            width: "100%",
            padding: 12,
            fontFamily: "var(--mono)",
            fontSize: 16,
            border: "1.5px solid var(--border)",
            borderRadius: 12,
            outline: "none",
            background: "var(--surface-2)",
            marginBottom: 12,
          }}
        />
        {err && (
          <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 10, fontFamily: "var(--mono)" }}>{err}</div>
        )}
        <button className="btn" style={{ width: "100%" }} disabled={busy} onClick={submit}>
          {busy ? "正在连接…" : "配对"}
        </button>
      </div>
    </div>
  );
}
