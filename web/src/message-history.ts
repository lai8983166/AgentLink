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
export function reconcileOutgoingHistory(history: HistoryItem[], messages: OutgoingMessage[]): {
  history: DisplayHistoryItem[]; confirmedIds: string[]; archived: OutgoingMessage[];
} {
  const matched = new Set<string>();
  const confirmedIds: string[] = [];
  const unresolved: OutgoingMessage[] = [];
  for (const message of messages) {
    const identity = history.find((item) => item.type === "userMessage" && !matched.has(item.id) &&
      (item.clientMessageId === message.id || item.id === message.id));
    const anchor = message.afterId === null ? -1 : history.findIndex((item) => item.id === message.afterId);
    // 本地 app-server 的旧消息没有关联 ID：只匹配发送时尚不存在、锚点之后的一条消息。
    // 待确认记录必须保留核对依据，不能仅凭相同文本推断接收成功。
    const fallback = !identity && message.state !== "uncertain" && (message.afterId === null || anchor >= 0) ? history.find((item, index) =>
      item.type === "userMessage" && !item.clientMessageId && !matched.has(item.id) &&
      index > anchor && !message.knownUserIds.includes(item.id) && item.text.trim() === message.text.trim()) : undefined;
    const found = identity || fallback;
    if (found) { matched.add(found.id); confirmedIds.push(message.id); }
    else unresolved.push(message);
  }
  const result: DisplayHistoryItem[] = [...history];
  // 桌面快照会裁剪旧历史。缺少定位消息的已接收记录保留供核对，不能再次追加到最新对话。
  // 空快照不代表历史裁剪；失败或未确认的发送也不能据此隐藏。
  const historyIds = new Set(history.map((item) => item.id));
  const archived = history.length === 0 ? [] : unresolved.filter((message) =>
    message.state === "accepted" && message.afterId !== null && !historyIds.has(message.afterId));
  const archivedIds = new Set(archived.map((message) => message.id));
  // 同一锚点连续发出的多条消息保持发送顺序；缺失锚点的未确认记录也不能反序。
  const lastInserted = new Map<string | null, string>();
  for (const message of unresolved) {
    if (archivedIds.has(message.id)) continue;
    const anchor = message.afterId === null ? -1 : result.findIndex((item) => item.id === message.afterId);
    const previous = lastInserted.get(message.afterId);
    const previousIndex = previous ? result.findIndex((item) => item.id === previous) : -1;
    const index = message.afterId !== null && anchor < 0 ? result.length : previousIndex >= 0 ? previousIndex + 1 : anchor + 1;
    result.splice(index, 0, { type: "userMessage", id: message.id, clientMessageId: message.id,
      text: message.text, at: message.at, deliveryState: message.state });
    lastInserted.set(message.afterId, message.id);
  }
  return { history: result, confirmedIds, archived };
}

export function mergeOutgoingHistory(history: HistoryItem[], messages: OutgoingMessage[]): DisplayHistoryItem[] {
  return reconcileOutgoingHistory(history, messages).history;
}
