import { describe, expect, test } from "vitest";
import type { HistoryItem } from "@agentlink/shared";
import { mergeOutgoingHistory, type OutgoingMessage } from "./message-history";

const row = (id: string, type: "userMessage" | "agentMessage", text = id): HistoryItem => ({ id, type, text, at: 1 });
const message = (id = "phone-1"): OutgoingMessage => ({ id, text: "继续", at: 2, state: "accepted", afterId: "old-reply", knownUserIds: ["old-user"] });
describe("发送后的即时消息与历史收敛", () => {
  test("模型先到仍将本地指令固定在发送位置；桌面 ID 不同也只显示一条", () => {
    const current = [row("old-reply", "agentMessage"), row("model", "agentMessage")];
    expect(mergeOutgoingHistory(current, [message()]).map((item) => item.id)).toEqual(["old-reply", "phone-1", "model"]);
    const canonical = [current[0]!, { ...row("server-1", "userMessage", "继续"), clientMessageId: "phone-1" }, current[1]!];
    expect(mergeOutgoingHistory(canonical, [message()]).map((item) => item.id)).toEqual(["old-reply", "server-1", "model"]);
  });
  test("相同文本的历史或其他发送 ID 不会吞掉新指令；多条发送保留顺序", () => {
    const history = [row("old-user", "userMessage", "继续"), row("old-reply", "agentMessage"),
      { ...row("different-user", "userMessage", "继续"), clientMessageId: "someone-else" }];
    expect(mergeOutgoingHistory(history, [message("p1"), message("p2")]).map((item) => item.id))
      .toEqual(["old-user", "old-reply", "p1", "p2", "different-user"]);
  });
  test("无关联 ID 的本地消息只能匹配锚点之后的新条目，且不能合并两次同文发送", () => {
    const history = [row("old-user", "userMessage", "继续"), row("old-reply", "agentMessage"), row("new-user", "userMessage", "继续")];
    expect(mergeOutgoingHistory(history, [message("p1"), message("p2")]).filter((item) => item.type === "userMessage")).toHaveLength(3);
  });
});
