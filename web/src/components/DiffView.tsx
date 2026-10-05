import type { HistoryItem } from "@agentlink/shared";

/** diff 全屏：逐行着色 + ± 统计（任务 7.4；内容来自 patchUpdated/outputTail） */
export function DiffView({
  item,
  onClose,
}: {
  item: Extract<HistoryItem, { type: "toolCall" }>;
  onClose: () => void;
}) {
  const lines = (item.outputTail ?? "").split("\n").filter((l) => l.trim() !== "");
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div className="topbar">
        <div className="back" onClick={onClose}>
          ‹
        </div>
        <div className="title">
          <div className="name" style={{ fontSize: 14 }}>
            改动预览
          </div>
          <div className="sub">{item.target}</div>
        </div>
        {item.diffStat && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700 }}>
            <span style={{ color: "var(--green)" }}>+{item.diffStat.added}</span>{" "}
            <span style={{ color: "var(--red)" }}>−{item.diffStat.removed}</span>
          </span>
        )}
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "10px 0",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          lineHeight: 1.75,
        }}
      >
        {lines.length === 0 ? (
          <div className="empty-note">
            本次改动未携带可展示的 patch 内容
            {item.diffStat ? `（统计 +${item.diffStat.added} −${item.diffStat.removed}）` : ""}
          </div>
        ) : (
          lines.map((l, i) => (
            <div
              key={i}
              style={{
                padding: "0 14px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                background: l.startsWith("+")
                  ? "rgba(31,138,59,.12)"
                  : l.startsWith("-")
                    ? "rgba(210,68,48,.10)"
                    : undefined,
                color: l.startsWith("+")
                  ? "#175c2a"
                  : l.startsWith("-")
                    ? "#8c2b1d"
                    : l.startsWith("@@")
                      ? "var(--accent)"
                      : "#7a7160",
                fontWeight: l.startsWith("@@") ? 700 : undefined,
              }}
            >
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
