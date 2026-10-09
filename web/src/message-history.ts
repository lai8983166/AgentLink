import type { HistoryItem } from "@agentlink/shared";

export type DeliveryState = "sending" | "accepted" | "failed" | "uncertain";
export interface OutgoingMessage {
  id: string;
  text: string;
  at: number;
  state: DeliveryState;
  afterId: string | null;
  knownUserIds: string[];
}
export type DisplayHistoryItem = HistoryItem & { deliveryState?: DeliveryState };

/** 本地消息固定在点击发送时的位置；桌面确认后用权威条目替代，不能重复显示。 */
export function mergeOutgoingHistory(history: HistoryItem[], messages: OutgoingMessage[]): DisplayHistoryItem[] {
  const matched = new Set<string>();
  const unresolved: OutgoingMessage[] = [];
  for (const message of messages) {
    const identity = history.find((item) => item.type === "userMessage" && !matched.has(item.id) &&
      (item.clientMessageId === message.id || item.id === message.id));
    const anchor = message.afterId === null ? -1 : history.findIndex((item) => item.id === message.afterId);
    // 本地 app-server 的旧消息没有关联 ID：只匹配发送时尚不存在、锚点之后的一条消息。
    const fallback = !identity && (message.afterId === null || anchor >= 0) ? history.find((item, index) =>
      item.type === "userMessage" && !item.clientMessageId && !matched.has(item.id) &&
      index > anchor && !message.knownUserIds.includes(item.id) && item.text === message.text) : undefined;
    const found = identity || fallback;
    if (found) matched.add(found.id);
    else unresolved.push(message);
  }
  const result: DisplayHistoryItem[] = [...history];
  // 同一锚点连续发出的多条消息保持发送顺序。
  for (const message of unresolved.reverse()) {
    const anchor = message.afterId === null ? -1 : result.findIndex((item) => item.id === message.afterId);
    const index = message.afterId !== null && anchor < 0 ? result.length : anchor + 1;
    result.splice(index, 0, { type: "userMessage", id: message.id, clientMessageId: message.id,
      text: message.text, at: message.at, deliveryState: message.state });
  }
  return result;
}
