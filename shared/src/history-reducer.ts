import type { HistoryItem } from "./domain";
import type { SessionEvent } from "./events";

export function applyEventToHistory(history: HistoryItem[], e: SessionEvent): HistoryItem[] {
  switch (e.type) {
    case "user.message": {
      const idx = history.findIndex((h) => h.type === "userMessage" && (h.id === e.itemId ||
        (!!e.clientMessageId && h.clientMessageId === e.clientMessageId)));
      const item = { type: "userMessage" as const, id: e.itemId, text: e.text, at: e.at,
        ...(e.clientMessageId ? { clientMessageId: e.clientMessageId } : {}) };
      const next = [...history];
      const updated = idx < 0 ? item : { ...next.splice(idx, 1)[0]!, ...item };
      const successor = e.beforeItemId ? next.findIndex((h) => h.id === e.beforeItemId) : -1;
      next.splice(successor >= 0 ? successor : idx >= 0 ? idx : next.length, 0, updated);
      return next;
    }
    case "agent.message": {
      // 同 id 消息：以最新文本为准（快照差分下首见可能是部分文本）
      const idx = history.findIndex((h) => h.type === "agentMessage" && h.id === e.itemId);
      if (idx >= 0) {
        const h = history[idx];
        if (h && h.type === "agentMessage" && h.text === e.text) return history;
        const next = [...history];
        next[idx] = { type: "agentMessage", id: e.itemId, text: e.text, at: e.at };
        return next;
      }
      return [...history, { type: "agentMessage", id: e.itemId, text: e.text, at: e.at }];
    }
    case "tool.started":
      return [
        ...history,
        {
          type: "toolCall",
          id: e.itemId,
          kind: e.kind,
          target: e.target,
          cmd: e.cmd,
          exitCode: null,
          durationMs: null,
          diffStat: null,
          outputTail: null,
          at: e.at,
        },
      ];
    case "tool.finished": {
      const idx = history.findIndex((h) => h.type === "toolCall" && h.id === e.itemId);
      if (idx === -1) {
        return [
          ...history,
          {
            type: "toolCall",
            id: e.itemId,
            kind: e.kind,
            target: e.target,
            cmd: null,
            exitCode: e.exitCode,
            durationMs: e.durationMs,
            diffStat: e.diffStat,
            outputTail: e.outputTail,
            at: e.at,
          },
        ];
      }
      const next = [...history];
      const h = next[idx];
      if (h?.type === "toolCall") {
        next[idx] = {
          ...h,
          exitCode: e.exitCode,
          durationMs: e.durationMs,
          diffStat: e.diffStat ?? h.diffStat,
          outputTail: e.outputTail ?? h.outputTail,
        };
      }
      return next;
    }
    default:
      return history;
  }
}

