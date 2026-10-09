import { describe, expect, test } from "bun:test";
import { normalizeSnapshot, diffDesktopState } from "./mapper";

describe("桌面对话顺序与手机消息关联", () => {
  test("按 islands 顺序读取轮次，并从参数保留手机发送 ID", () => {
    const state = normalizeSnapshot({ turnHistory: { history: {
      entitiesByKey: {
        newer: { turnId: "t2", params: { clientUserMessageId: "phone-1" }, items: [{ id: "server-1", type: "userMessage", text: "继续" }] },
        older: { turnId: "t1", items: [{ id: "reply-1", type: "agentMessage", text: "旧回复" }] },
        tail: { turnId: "t3", items: [] },
      },
      islands: [{ entries: [{ key: "sort-1", value: "older" }, { key: "sort-2", value: "newer" }, { value: "newer" }, { value: "missing" }] }],
    } } });
    expect(state.turns.map((t) => t.turnId)).toEqual(["t1", "t2", "t3"]);
    expect(state.turns[1]!.items[0]).toMatchObject({ key: "server-1", clientMessageId: "phone-1" });
    expect(diffDesktopState(null, state)).toContainEqual({ kind: "user.message", itemId: "server-1", clientMessageId: "phone-1", text: "继续" });
  });
  test("用户指令晚于模型回复进入快照时要求按权威顺序重建；正常追加不重拉", () => {
    const snapshot = (items: Array<{ id: string; type: string; text: string }>) => normalizeSnapshot({ turnHistory: { history: { entitiesByKey: { t: { items } } } } });
    const reply = { id: "reply", type: "agentMessage", text: "收到" };
    const user = { id: "user", type: "userMessage", text: "继续" };
    expect(diffDesktopState(snapshot([reply]), snapshot([user, reply]))).toContainEqual({ kind: "history.sync" });
    expect(diffDesktopState(snapshot([user]), snapshot([user, reply])).some((f) => f.kind === "history.sync")).toBe(false);
  });
});
