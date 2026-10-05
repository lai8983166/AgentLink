import { useState } from "react";
import type { HistoryItem } from "@agentlink/shared";
import { DiffView } from "./DiffView";

/** 工具卡片：默认折叠一行摘要，点开看输出；文件改动点开全屏 diff（任务 7.4） */
export function ToolCard({ item }: { item: Extract<HistoryItem, { type: "toolCall" }> }) {
  const [open, setOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const isFile = item.kind === "fileChange";
  const meta =
    isFile && item.diffStat ? (
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700 }}>
        <span style={{ color: "var(--green)" }}>+{item.diffStat.added}</span>{" "}
        <span style={{ color: "var(--red)" }}>−{item.diffStat.removed}</span>
      </span>
    ) : item.exitCode != null ? (
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: item.exitCode === 0 ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
        {item.exitCode === 0 ? "✓" : "✕"} exit {item.exitCode}
        {item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}
      </span>
    ) : (
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-faint)" }}>执行中…</span>
    );

  return (
    <div
      style={{
        margin: "10px 0 0",
        border: "1.5px solid var(--border)",
        borderRadius: 12,
        background: "var(--surface)",
        boxShadow: "2px 2px 0 rgba(34,28,14,.85)",
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => (isFile ? setDiffOpen(true) : setOpen(!open))}
        style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px", cursor: "pointer", fontSize: 13 }}
      >
        <span style={{ width: 20, textAlign: "center" }}>{isFile ? "✏️" : "🖥"}</span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {isFile ? item.target : (item.cmd ?? item.target)}
        </span>
        {meta}
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)" }}>{isFile ? "▶" : open ? "▼" : "▶"}</span>
      </div>
      {open && item.outputTail && !isFile && (
        <div style={{ padding: "0 12px 10px" }}>
          <pre
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              lineHeight: 1.6,
              color: "var(--text-dim)",
              background: "var(--surface-2)",
              border: "1px dashed #d9cdaa",
              borderRadius: 8,
              padding: "9px 10px",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 260,
            }}
          >
            {item.outputTail}
          </pre>
        </div>
      )}
      {diffOpen && <DiffView item={item} onClose={() => setDiffOpen(false)} />}
    </div>
  );
}
