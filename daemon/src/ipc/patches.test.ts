import { describe, expect, test } from "bun:test";
import { applyConversationPatches } from "./patches";

describe("桌面增量补丁", () => {
  test("对象和数组增删改保持原快照不变；一批补丁可依赖前一条结果", () => {
    const original = { id: "c1", requests: [{ id: "first" }, { id: "last" }] };
    const next = applyConversationPatches(original, [
      { op: "add", path: ["requests", 1], value: { id: "middle" } },
      { op: "replace", path: ["requests", 0, "id"], value: "new" },
      { op: "remove", path: ["requests", 2] },
      { op: "add", path: ["title"], value: "hello" },
    ]);
    expect(next).toEqual({ id: "c1", title: "hello", requests: [{ id: "new" }, { id: "middle" }] });
    expect(original).toEqual({ id: "c1", requests: [{ id: "first" }, { id: "last" }] });
  });
  test("缺失路径、非法数组下标和原型写入必须拒绝；失败不修改原状态", () => {
    const state = { requests: [] };
    for (const path of [["missing", "text"], ["requests", 3], ["__proto__", "polluted"], ["constructor", "prototype", "polluted"]]) {
      expect(() => applyConversationPatches(state, [{ op: "add", path, value: true }])).toThrow();
    }
    expect(() => applyConversationPatches(state, [{ op: "add", path: ["title"], value: "first" }, { op: "remove", path: ["missing"] }])).toThrow();
    expect(state).toEqual({ requests: [] });
  });
});
