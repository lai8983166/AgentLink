import { useState } from "react";
import type { ApprovalDecision } from "@agentlink/shared";
import { visibleDecisions } from "../store";
import { api } from "../runtime";

/** 审批卡片：动态决定按钮 + 一次点击决定（任务 7.5） */
export interface PendingApprovalUI {
  approvalId: string;
  kind: "command" | "fileChange";
  command: string | null;
  cwd: string;
  reason: string | null;
  availableDecisions: Array<string | Record<string, unknown>>;
}

export function ApprovalCard({
  a,
  sessionId,
  resolved,
  onResolved,
}: {
  a: PendingApprovalUI;
  sessionId: string;
  resolved: { decision: string } | null;
  onResolved: (approvalId: string, decision: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(d: ApprovalDecision) {
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(sessionId, a.approvalId, d);
      onResolved(a.approvalId, d);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "提交失败";
      // 已作废/已被占用等：通知上层移除卡片
      if (msg.includes("APPROVAL_EXPIRED") || (e as { code?: string }).code === "APPROVAL_EXPIRED") {
        onResolved(a.approvalId, "expired");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  const decisions = visibleDecisions(a.availableDecisions);
  const label: Record<ApprovalDecision, string> = {
    accept: "批准",
    acceptForSession: "批准（本会话不再询问）",
    decline: "拒绝（agent 继续）",
    cancel: "拒绝并中断",
  };

  if (resolved) {
    const text =
      resolved.decision === "expired"
        ? "已作废（轮次结束）"
        : resolved.decision === "accept"
          ? "✓ 已批准"
          : resolved.decision === "acceptForSession"
            ? "✓ 已批准 · 本会话同类自动通过"
            : resolved.decision === "decline"
              ? "✕ 已拒绝 · agent 另想办法"
              : "✕ 已拒绝并中断";
    return (
      <div
        style={{
          margin: "14px 0 0",
          border: "1.5px dashed var(--border)",
          borderRadius: 16,
          background: "var(--surface)",
          padding: "12px 14px",
          fontSize: 12.5,
          fontWeight: 550,
          color: resolved.decision.startsWith("accept") ? "var(--green)" : resolved.decision === "expired" ? "var(--text-faint)" : "var(--red)",
        }}
      >
        {a.command ?? "文件改动"} — {text}
      </div>
    );
  }

  return (
    <div
      id={`approval-${a.approvalId}`}
      style={{
        margin: "14px 0 0",
        border: "1.5px solid var(--border)",
        borderRadius: 16,
        background: "#fffae3",
        boxShadow: "4px 4px 0 var(--border)",
        padding: "13px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--gold-deep)" }}>
        ⚠️ {a.kind === "command" ? "请求执行命令" : "请求修改文件"}
      </div>
      {a.command && (
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12.5,
            background: "var(--surface)",
            border: "1.5px solid var(--border)",
            borderRadius: 9,
            padding: "10px 11px",
            marginTop: 10,
            wordBreak: "break-all",
            lineHeight: 1.5,
          }}
        >
          {a.command}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)", marginTop: 7 }}>{a.cwd}</div>
      {a.command?.includes("rm ") && (
        <div style={{ fontSize: 11.5, color: "var(--red)", marginTop: 8 }}>⚠ 含删除操作 · 请确认</div>
      )}
      {a.reason && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.6, borderTop: "1px dotted #cbbe97", paddingTop: 8 }}>
          Agent 说明：{a.reason}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 9, marginTop: 13 }}>
        {decisions.includes("decline") && (
          <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={() => decide("decline")}>
            拒绝
          </button>
        )}
        {decisions.includes("cancel") && decisions.indexOf("cancel") < decisions.indexOf("accept") && !decisions.includes("decline") && (
          <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={() => decide("cancel")}>
            拒绝并中断
          </button>
        )}
        <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => decide("accept")}>
          批准
        </button>
      </div>
      {decisions.includes("acceptForSession") && (
        <div
          style={{ textAlign: "center", fontSize: 11.5, color: "var(--text-dim)", marginTop: 11, cursor: busy ? "default" : "pointer", textDecoration: "underline dotted", fontFamily: "var(--mono)" }}
          onClick={() => !busy && decide("acceptForSession")}
        >
          批准，且本会话内不再询问此类操作
        </div>
      )}
    </div>
  );
}
