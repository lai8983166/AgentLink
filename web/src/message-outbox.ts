import { useRef, useState } from "react";
import { api } from "./runtime";
import type { HistoryItem } from "@agentlink/shared";
import type { DeliveryState, OutgoingMessage } from "./message-history";

type Outbox = { text: string; id: string | null; state: "draft" | "sending" | "accepted" | "failed" | "uncertain" };
const empty = (): Outbox => ({ text: "", id: null, state: "draft" });
function read(key: string): Outbox {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && typeof value.text === "string" && (value.id === null || typeof value.id === "string")) {
      return { ...value, state: value.state === "sending" ? "uncertain" : value.state };
    }
  } catch { /* 损坏或不可用的草稿不影响操作 */ }
  return empty();
}

function readMessages(key: string): OutgoingMessage[] {
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(list)) return list.filter((m) => m && typeof m.id === "string" && typeof m.text === "string" &&
      typeof m.at === "number" && (m.afterId === null || typeof m.afterId === "string") &&
      Array.isArray(m.knownUserIds) && m.knownUserIds.every((id: unknown) => typeof id === "string") &&
      ["sending", "accepted", "failed", "uncertain"].includes(m.state))
      .map((m) => ({ ...m, state: m.state === "sending" ? "uncertain" : m.state }));
  } catch { /* 存储不可用时使用内存中的记录 */ }
  return [];
}

export function useMessageOutbox(sessionId: string, options: { history?: () => HistoryItem[]; onAccepted?: () => void } = {}) {
  const key = `agentlink-outbox:${sessionId}`;
  const messagesKey = `agentlink-messages:${sessionId}`;
  const [messages, setMessages] = useState<OutgoingMessage[]>(() => readMessages(messagesKey));
  const messagesRef = useRef(messages);
  const [outbox, setOutbox] = useState<Outbox>(() => read(key));
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(outbox.state === "uncertain" ? "上次发送结果待确认，请核对发送结果" : null);
  const busy = useRef(false);
  function save(next: Outbox) {
    setOutbox(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 存储不可用时保留内存中的草稿 */ }
  }
  function record(id: string, state: DeliveryState, text?: string) {
    let next = messagesRef.current.map((message) => message.id === id ? { ...message, state } : message);
    if (text !== undefined && !next.some((message) => message.id === id)) {
      const history = options.history?.() ?? [];
      next.push({ id, text, state, at: Date.now(), afterId: history.at(-1)?.id ?? null,
        knownUserIds: history.filter((item) => item.type === "userMessage").map((item) => item.id) });
    }
    const disposable = next.filter((m) => m.state === "accepted" || m.state === "failed").slice(-100);
    next = next.filter((m) => m.state === "sending" || m.state === "uncertain" || disposable.includes(m));
    messagesRef.current = next; setMessages(next);
    try { localStorage.setItem(messagesKey, JSON.stringify(next)); } catch { /* 保留内存记录 */ }
  }
  function accepted(id: string) { record(id, "accepted"); save(empty()); setNotice("电脑端已接收"); options.onAccepted?.(); }
  async function recheck() {
    if (!outbox.id) return;
    try {
      const { receipt } = await api.messageReceipt(sessionId, outbox.id);
      if (receipt?.state === "accepted") accepted(outbox.id);
      else if (receipt?.state === "failed" || receipt === null) {
        save({ ...outbox, state: "failed" }); setNotice(receipt?.error ?? "电脑端未接收，可重试发送");
        record(outbox.id, "failed");
      } else setNotice(receipt?.error ?? "发送结果待确认，请核对原会话");
    } catch { setNotice("暂时无法核对发送结果，请连接恢复后重试"); }
  }
  async function submit() {
    const text = outbox.text.trim();
    if (!text || busy.current) return;
    if (outbox.state === "uncertain") { await recheck(); return; }
    const message = { text, id: outbox.id ?? crypto.randomUUID(), state: "sending" as const };
    busy.current = true; setSending(true); setNotice("发送中…"); save(message);
    record(message.id, "sending", text);
    try {
      const result = await api.sendMessage(sessionId, text, message.id);
      if (result.receipt && result.receipt.state !== "accepted") throw new Error("发送结果待确认");
      accepted(message.id);
    } catch (e) {
      const error = e instanceof Error ? e.message : "发送失败";
      try {
        const { receipt } = await api.messageReceipt(sessionId, message.id);
        if (receipt?.state === "accepted") accepted(message.id);
        else {
          const state = receipt?.state === "failed" || receipt === null ? "failed" : "uncertain";
          save({ ...message, state }); setNotice(receipt?.error ?? error);
          record(message.id, state);
        }
      } catch { save({ ...message, state: "uncertain" }); record(message.id, "uncertain"); setNotice(`${error}；接收结果待确认`); }
    } finally { busy.current = false; setSending(false); }
  }
  return { input: outbox.text, messages, sending, notice, uncertain: outbox.state === "uncertain", submit, recheck,
    setInput: (text: string) => save(text === outbox.text ? outbox : { text, id: null, state: "draft" }), };
}
