import type { ReactNode } from "react";

/** markdown-lite：代码围栏 + 行内 code + 换行（agent 输出的常见形态） */
export function MarkdownLite({ text }: { text: string }): ReactNode {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          // 代码块：去掉语言行
          const body = part.replace(/^[a-zA-Z0-9_-]*\n/, "");
          return (
            <pre
              key={i}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                lineHeight: 1.6,
                background: "var(--surface-2)",
                border: "1px dashed #d9cdaa",
                borderRadius: 8,
                padding: "9px 10px",
                overflowX: "auto",
                margin: "8px 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {body}
            </pre>
          );
        }
        return <InlineText key={i} text={part} />;
      })}
    </>
  );
}

function InlineText({ text }: { text: string }): ReactNode {
  const segs = text.split(/`([^`]+)`/g);
  return (
    <>
      {segs.map((seg, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              background: "#fff1a8",
              border: "1px solid #e9da82",
              padding: "1px 5px",
              borderRadius: 5,
              color: "#5a4a00",
            }}
          >
            {seg}
          </code>
        ) : (
          <span key={i} style={{ whiteSpace: "pre-wrap" }}>
            {seg}
          </span>
        ),
      )}
    </>
  );
}
