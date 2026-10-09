import { useRef, useState } from "react";
import { api } from "./runtime";

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

export function useMessageOutbox(sessionId: string) {
  const key = `agentlink-outbox:${sessionId}`;
  const [outbox, setOutbox] = useState<Outbox>(() => read(key));
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(outbox.state === "uncertain" ? "上次发送结果待确认，请核对发送结果" : null);
  const busy = useRef(false);
  function save(next: Outbox) {
    setOutbox(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 存储不可用时保留内存中的草稿 */ }
  }
  function accepted() { save(empty()); setNotice("电脑端已接收"); }
  async function recheck() {
    if (!outbox.id) return;
    try {
      const { receipt } = await api.messageReceipt(sessionId, outbox.id);
      if (receipt?.state === "accepted") accepted();
      else if (receipt?.state === "failed" || receipt === null) {
        save({ ...outbox, state: "failed" }); setNotice(receipt?.error ?? "电脑端未接收，可重试发送");
      } else setNotice(receipt?.error ?? "发送结果待确认，请核对原会话");
    } catch { setNotice("暂时无法核对发送结果，请连接恢复后重试"); }
  }
  async function submit() {
    const text = outbox.text.trim();
    if (!text || busy.current) return;
    if (outbox.state === "uncertain") { await recheck(); return; }
    const message = { text, id: outbox.id ?? crypto.randomUUID(), state: "sending" as const };
    busy.current = true; setSending(true); setNotice("发送中…"); save(message);
    try {
      const result = await api.sendMessage(sessionId, text, message.id);
      if (result.receipt && result.receipt.state !== "accepted") throw new Error("发送结果待确认");
      accepted();
    } catch (e) {
      const error = e instanceof Error ? e.message : "发送失败";
      try {
        const { receipt } = await api.messageReceipt(sessionId, message.id);
        if (receipt?.state === "accepted") accepted();
        else {
          const state = receipt?.state === "failed" || receipt === null ? "failed" : "uncertain";
          save({ ...message, state }); setNotice(receipt?.error ?? error);
        }
      } catch { save({ ...message, state: "uncertain" }); setNotice(`${error}；接收结果待确认`); }
    } finally { busy.current = false; setSending(false); }
  }
  return { input: outbox.text, sending, notice, uncertain: outbox.state === "uncertain", submit, recheck,
    setInput: (text: string) => save(text === outbox.text ? outbox : { text, id: null, state: "draft" }), };
}
