import { create } from "zustand";
import type { ApprovalDecision, HistoryItem, SessionEvent, SessionStatus } from "@agentlink/shared";

/** UI 态（zustand）：token 配对、滚动跟随、连接状态 */
interface AgentLinkStore {
  token: string | null;
  setToken: (t: string) => void;
  clearToken: () => void;
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;
  inputAtTop: boolean;
  setInputAtTop: (value: boolean) => void;
}

export const useStore = create<AgentLinkStore>((set) => ({
  token: localStorage.getItem("agentlink-token"),
  setToken: (t) => {
    localStorage.setItem("agentlink-token", t);
    set({ token: t });
  },
  clearToken: () => {
    localStorage.removeItem("agentlink-token");
    set({ token: null });
  },
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),
  inputAtTop: (() => { try { return localStorage.getItem("agentlink-input-at-top") === "true"; } catch { return false; } })(),
  setInputAtTop: (value) => {
    try { localStorage.setItem("agentlink-input-at-top", String(value)); } catch { /* Keep the current preference in memory. */ }
    set({ inputAtTop: value });
  },
}));

/** 会话页的滚动跟随状态（组件外持有，避免重渲染竞争） */
export const followState = { following: true };

/** 审批卡片动态按钮：只渲染 availableDecisions 中的规范决定（mobile-client spec） */
export function visibleDecisions(available: Array<string | Record<string, unknown>>): ApprovalDecision[] {
  const canonical: ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];
  const strings = available.filter((a): a is string => typeof a === "string");
  if (strings.length === 0) return ["accept"]; // 空列表兜底：只保主按钮
  const set = new Set(strings);
  return canonical.filter((d) => set.has(d));
}

/** 事件 → 历史条目增量（会话详情缓存更新的纯函数，测试覆盖） */
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

/** 首页排序（mobile-client spec：等待审批 > 运行中 > 已完成 > 出错 > 空闲） */
export const STATUS_ORDER: Record<SessionStatus, number> = {
  waiting_approval: 0,
  running: 1,
  done: 2,
  error: 3,
  idle: 4,
  unknown: 5,
};
