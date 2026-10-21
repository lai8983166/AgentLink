import { useEffect, useRef, useState } from "react";
import { api } from "./runtime";
import type { HistoryItem } from "@agentlink/shared";
import type { DeliveryState, OutgoingMessage } from "./message-history";
import { reconcileOutgoingHistory } from "./message-history";

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
  const outboxRef = useRef(outbox);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(outbox.state === "uncertain" ? "上次发送结果待确认，请核对发送结果" : null);
  const busy = useRef(false);
  const checkingIds = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function saveMessages(next: OutgoingMessage[]) {
    messagesRef.current = next; setMessages(next);
    try { localStorage.setItem(messagesKey, JSON.stringify(next)); } catch { /* 保留内存记录 */ }
  }
  // 一旦权威历史确认了发送记录，就删除本地占位，防止历史裁剪后重新冒出来。
  useEffect(() => {
    const current = messagesRef.current;
    const history = options.history?.() ?? [];
    const confirmed = new Set(reconcileOutgoingHistory(history, current).confirmedIds);
    const exact = (message: { id: string | null; text: string }) => !!message.id && history.some((item) =>
      item.type === "userMessage" && (item.clientMessageId === message.id || item.id === message.id) && item.text.trim() === message.text.trim());
    const next = current.filter((message) => message.state === "accepted" ? !confirmed.has(message.id) :
      message.state !== "uncertain" || !exact(message));
    if (next.length !== current.length) saveMessages(next);
    if (outboxRef.current.state === "uncertain" && exact(outboxRef.current)) {
      save(empty()); setNotice("已从原会话确认接收");
    } else if (outboxRef.current.state === "draft" && current.some((message) => message.state === "uncertain" && exact(message))) {
      setNotice("旧指令已从原会话确认接收，新草稿已保留");
    }
  }, [messages, options.history, outbox.id, outbox.state]);
  // 只查询结果，不重新执行。返回前台或恢复网络后立即核对，前台定时补偿回执丢失。
  useEffect(() => {
    if (outbox.state !== "uncertain" || !outbox.id) return;
    const check = () => {
      if (document.visibilityState === "visible" && outboxRef.current.id === outbox.id && outboxRef.current.state === "uncertain") void recheck();
    };
    check();
    const timer = setInterval(check, 10000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); window.removeEventListener("online", check); };
  }, [outbox.id, outbox.state]);
  function save(next: Outbox) {
    outboxRef.current = next; setOutbox(next);
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
    saveMessages(next);
  }
  function accepted(id: string) {
    if (!alive.current) return;
    record(id, "accepted");
    // 查询旧消息时用户可能已经在写新草稿，迟到回执不能清掉新输入。
    if (outboxRef.current.id === id) { save(empty()); setNotice("电脑端已接收"); }
    else if (outboxRef.current.state === "draft") setNotice("旧指令已确认接收，新草稿已保留");
    options.onAccepted?.();
  }
  async function recheck() {
    const pending = outboxRef.current;
    const id = pending.id;
    if (!id || checkingIds.current.has(id)) return;
    checkingIds.current.add(id); setChecking(true);
    try {
      const { receipt } = await api.messageReceipt(sessionId, id);
      if (!alive.current) return;
      if (receipt?.state === "accepted") accepted(id);
      else if (receipt?.state === "failed") {
        record(id, "failed");
        if (outboxRef.current.id === id) { save({ ...pending, state: "failed" }); setNotice(receipt.error ?? "电脑端未接收，可重试发送"); }
        else if (outboxRef.current.state === "draft") setNotice("旧指令发送失败，新草稿已保留");
      } else if (outboxRef.current.id === id) setNotice(receipt?.error ?? "发送结果仍待确认，旧记录已保留；可核对原会话或输入新指令");
    } catch { if (alive.current && outboxRef.current.id === id) setNotice("暂时无法核对发送结果，请连接恢复后重试"); }
    finally { checkingIds.current.delete(id); if (alive.current) setChecking(checkingIds.current.size > 0); }
  }
  async function submit() {
    const current = outboxRef.current;
    const text = current.text.trim();
    if (!text || busy.current) return;
    if (current.state === "uncertain") { await recheck(); return; }
    const message = { text, id: current.id ?? crypto.randomUUID(), state: "sending" as const };
    busy.current = true; setSending(true); setNotice("发送中…"); save(message);
    record(message.id, "sending", text);
    try {
      const result = await api.sendMessage(sessionId, text, message.id);
      if (!alive.current) return;
      if (result.receipt && result.receipt.state !== "accepted") throw new Error("发送结果待确认");
      accepted(message.id);
    } catch (e) {
      if (!alive.current) return;
      const error = e instanceof Error ? e.message : "发送失败";
      try {
        const { receipt } = await api.messageReceipt(sessionId, message.id);
        if (!alive.current) return;
        if (receipt?.state === "accepted") accepted(message.id);
        else {
          const state = receipt?.state === "failed" ? "failed" : "uncertain";
          save({ ...message, state }); setNotice(receipt?.error ?? error);
          record(message.id, state);
        }
      } catch {
        if (!alive.current) return;
        save({ ...message, state: "uncertain" }); record(message.id, "uncertain"); setNotice(`${error}；接收结果待确认`);
      }
    } finally { busy.current = false; if (alive.current) setSending(false); }
  }
  return { input: outbox.text, messages, sending, checking, notice, uncertain: outbox.state === "uncertain", submit, recheck,
    beginNewPrompt: () => {
      const pending = outboxRef.current;
      if (pending.state !== "uncertain" || !pending.id) return;
      record(pending.id, "uncertain", pending.text);
      save(empty()); setNotice("旧指令仍待核对，记录已保留；可输入新指令");
    },
    forgetAccepted: (ids: string[]) => {
      const selected = new Set(ids);
      saveMessages(messagesRef.current.filter((message) => message.state !== "accepted" || !selected.has(message.id)));
    },
    setInput: (text: string) => {
      const current = outboxRef.current;
      if (text === current.text) return;
      if (current.state === "uncertain" && current.id) record(current.id, "uncertain", current.text);
      save({ text, id: null, state: "draft" });
      if (current.state === "uncertain") setNotice("旧指令仍待核对，记录已保留；可输入新指令");
    }, };
}
