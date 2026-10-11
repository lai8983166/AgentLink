import { describe, expect, test } from "vitest";
import type { HistoryItem } from "@agentlink/shared";
import { mergeOutgoingHistory, reconcileOutgoingHistory, type OutgoingMessage } from "./message-history";

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
  test("旧锚点已被裁剪：三条已接收记录移出对话，但不冒充历史确认；失败和未确认保留", () => {
    const old = [message("old-1"), message("old-2"), message("old-3")];
    const failed = { ...message("failed"), state: "failed" as const };
    const uncertain = { ...message("uncertain"), state: "uncertain" as const };
    const sending = { ...message("sending"), state: "sending" as const };
    const current = [row("new-reply", "agentMessage")];
    const result = reconcileOutgoingHistory(current, [...old, failed, uncertain, sending]);
    expect(result.history.map((h) => h.id)).toEqual(["new-reply", "failed", "uncertain", "sending"]);
    expect(result.archived).toEqual(old);
    expect(result.confirmedIds).toEqual([]);
  });
  test("快照仍未到时不误归档；原始锚点被裁剪但 ID 匹配时仍可确认", () => {
    expect(reconcileOutgoingHistory([], [message()]).archived).toEqual([]);
    const result = reconcileOutgoingHistory([{ id: "server", type: "userMessage", text: "继续\n", at: 1, clientMessageId: "phone-1" }], [message()]);
    expect(result.archived).toEqual([]);
    expect(result.confirmedIds).toEqual(["phone-1"]);
    expect(result.history.map((h) => h.id)).toEqual(["server"]);
  });
  test("客户端提交时会去掉边缘空白，旧本地历史的尾部换行不阻止确认", () => {
    const history = [row("old-reply", "agentMessage"), row("server", "userMessage", "继续\n")];
    expect(reconcileOutgoingHistory(history, [message()]).confirmedIds).toEqual(["phone-1"]);
  });
});
