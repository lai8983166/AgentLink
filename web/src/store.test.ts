import { describe, expect, test } from "vitest";
import { applyEventToHistory, STATUS_ORDER, visibleDecisions } from "./store";
import type { HistoryItem } from "@agentlink/shared";

describe("visibleDecisions（任务 7.5：动态按钮）", () => {
  test("只渲染可用列表中的决定", () => {
    expect(visibleDecisions(["accept", "cancel"])).toEqual(["accept", "cancel"]);
    expect(visibleDecisions(["accept"])).toEqual(["accept"]);
  });

  test("对象型高级决定不产生按钮，字符串决定渲染", () => {
    expect(visibleDecisions(["accept", { acceptWithExecpolicyAmendment: {} }, "cancel"])).toEqual(["accept", "cancel"]);
  });

  test("空列表兜底为 accept（主按钮）", () => {
    expect(visibleDecisions([])).toEqual(["accept"]);
  });
});

describe("applyEventToHistory（任务 7.2/7.4：事件增量）", () => {
  test("agent.message 首见部分文本 → 后续全文更新（快照差分语义）", () => {
    let h: HistoryItem[] = [];
    h = applyEventToHistory(h, { type: "agent.message", sessionId: "s", seq: 1, at: 1, itemId: "m1", text: "正在" });
    expect(h).toHaveLength(1);
    // 快照推进：全文到达 → 更新而非丢弃
    h = applyEventToHistory(h, {
      type: "agent.message",
      sessionId: "s",
      seq: 2,
      at: 2,
      itemId: "m1",
      text: "正在分析项目结构并给出方案",
    });
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ type: "agentMessage", text: "正在分析项目结构并给出方案" });
    // 相同文本重复 → 不变
    h = applyEventToHistory(h, { type: "agent.message", sessionId: "s", seq: 3, at: 3, itemId: "m1", text: "正在分析项目结构并给出方案" });
    expect(h).toHaveLength(1);
  });

  test("user.message（接管后手机指令）入流且去重", () => {
    let h: HistoryItem[] = [];
    h = applyEventToHistory(h, { type: "user.message", sessionId: "s", seq: 1, at: 1, itemId: "u1", text: "跑一下构建" });
    h = applyEventToHistory(h, { type: "user.message", sessionId: "s", seq: 2, at: 1, itemId: "u1", text: "跑一下构建" });
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ type: "userMessage", text: "跑一下构建" });
  });

  test("tool.started → tool.finished 原位更新", () => {
    let h: HistoryItem[] = [];
    h = applyEventToHistory(h, {
      type: "tool.started", sessionId: "s", seq: 1, at: 1, itemId: "e1", kind: "exec", target: "pnpm", cmd: "pnpm build",
    });
    h = applyEventToHistory(h, {
      type: "tool.finished", sessionId: "s", seq: 2, at: 1, itemId: "e1", kind: "exec", target: "pnpm",
      exitCode: 0, durationMs: 1200, diffStat: null, outputTail: "done",
    });
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ type: "toolCall", exitCode: 0, durationMs: 1200, outputTail: "done" });
  });

  test("错过 started 时 finished 补建条目", () => {
    const h = applyEventToHistory([], {
      type: "tool.finished", sessionId: "s", seq: 1, at: 1, itemId: "e9", kind: "fileChange", target: "a.ts",
      exitCode: null, durationMs: null, diffStat: { added: 3, removed: 1 }, outputTail: null,
    });
    expect(h[0]).toMatchObject({ type: "toolCall", diffStat: { added: 3, removed: 1 } });
  });
});

describe("首页状态排序（任务 7.3）", () => {
  test("等待审批 > 运行中 > 已完成 > 出错 > 空闲", () => {
    expect(STATUS_ORDER.waiting_approval).toBeLessThan(STATUS_ORDER.running);
    expect(STATUS_ORDER.running).toBeLessThan(STATUS_ORDER.done);
    expect(STATUS_ORDER.done).toBeLessThan(STATUS_ORDER.error);
    expect(STATUS_ORDER.error).toBeLessThan(STATUS_ORDER.idle);
  });
});
