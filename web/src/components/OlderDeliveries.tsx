import type { OutgoingMessage } from "../message-history";

/** 本地发送记录不等于完整会话历史；已不在当前历史中的旧记录不挤占最新对话。 */
export function OlderDeliveries({ messages, onDismiss }: { messages: OutgoingMessage[]; onDismiss: (ids: string[]) => void }) {
  if (!messages.length) return null;
  return (
    <details data-testid="older-deliveries" style={{ margin: "14px 2px", padding: "10px 12px", border: "1px solid var(--border-soft)", borderRadius: 10, color: "var(--text-dim)", fontSize: 12 }}>
      <summary style={{ cursor: "pointer" }}>已接收的旧发送记录（{messages.length}）</summary>
      <p>当前显示的历史不包含这些旧记录。接收回执表示电脑已接收，可在原会话中核对处理结果。</p>
      {messages.map((message) => <div key={message.id} style={{ margin: "8px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        <time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleString()}</time>
        <div>{message.text}</div>
      </div>)}
      <button className="btn ghost" onClick={() => onDismiss(messages.map((message) => message.id))}>清除这些本地提示</button>
    </details>
  );
}
