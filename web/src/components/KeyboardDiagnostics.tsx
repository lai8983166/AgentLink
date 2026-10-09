import { useState } from "react";
import { keyboardDiagnosticReport } from "../visible-viewport";
import { useStore } from "../store";

export function KeyboardDiagnostics() {
  const inputAtTop = useStore((s) => s.inputAtTop);
  const setInputAtTop = useStore((s) => s.setInputAtTop);
  const [report, setReport] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function copy() {
    const text = keyboardDiagnosticReport(); setReport(text);
    try {
      await navigator.clipboard.writeText(text);
      setNotice("诊断信息已复制，可发送给我排查");
    } catch { setNotice("请长按下方诊断信息，全选复制"); }
  }
  return <details className="card" style={{ fontSize: 12, cursor: "default" }}>
    <summary>输入框仍被键盘遮挡？</summary>
    <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
      <input type="checkbox" checked={inputAtTop} onChange={(event) => setInputAtTop(event.target.checked)} />
      会话输入栏固定在顶部（兼容模式）
    </label>
    <p style={{ margin: "10px 0", lineHeight: 1.7 }}>无法获得键盘尺寸时，Android 触摸设备会在输入期间自动将会话输入栏移至顶部。也可勾选上方选项，始终使用顶部输入栏。</p>
    <p style={{ margin: "10px 0", lineHeight: 1.7 }}>先在会话里弹出键盘并输入，再回到这里复制布局诊断。</p>
    <button className="btn ghost" onClick={copy}>复制布局诊断</button>
    {notice && <div role="status" style={{ margin: "10px 0" }}>{notice}</div>}
    {report && <textarea aria-label="布局诊断信息" readOnly value={report} style={{ width: "100%", height: 150, fontSize: 12 }} />}
  </details>;
}
