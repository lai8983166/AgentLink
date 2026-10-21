import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useMessageOutbox } from "./message-outbox";
import { api } from "./runtime";
vi.mock("./runtime", () => ({ api: { sendMessage: vi.fn(), messageReceipt: vi.fn() } }));
beforeEach(() => { vi.mocked(api.sendMessage).mockReset(); vi.mocked(api.messageReceipt).mockReset(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("手机指令草稿与回执", () => {
  test("重开时原会话中同 ID 的消息自动解除待确认，不查询或重发旧指令", () => {
    const pending = { id: "m1", text: "继续推进", state: "uncertain" };
    localStorage.setItem("agentlink-outbox:s1", JSON.stringify(pending));
    localStorage.setItem("agentlink-messages:s1", JSON.stringify([{ ...pending, at: 1, afterId: "old", knownUserIds: [] }]));
    const { result } = renderHook(() => useMessageOutbox("s1", { history: () => [{ type: "userMessage", id: "native", clientMessageId: "m1", text: "继续推进\n", at: 2 }] }));
    expect(result.current.uncertain).toBe(false);
    expect(result.current.input).toBe("");
    expect(result.current.messages).toEqual([]);
    expect(api.messageReceipt).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  test("自动核对临时失败后恢复联网可以解除旧状态，查询不自动发送", async () => {
    localStorage.setItem("agentlink-outbox:s1", JSON.stringify({ id: "m1", text: "继续", state: "uncertain" }));
    vi.mocked(api.messageReceipt).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ receipt: { clientMessageId: "m1", state: "accepted", updatedAt: 2, error: null } });
    const { result } = renderHook(() => useMessageOutbox("s1"));
    await act(async () => {});
    expect(result.current.uncertain).toBe(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(result.current.uncertain).toBe(false); expect(result.current.input).toBe("");
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  test("尚无回执不等于未接收；同文不同 ID 也不能补确认，可保留旧记录后发送新指令", async () => {
    localStorage.setItem("agentlink-outbox:s1", JSON.stringify({ id: "m1", text: "继续", state: "uncertain" }));
    vi.mocked(api.messageReceipt).mockResolvedValue({ receipt: null });
    const { result } = renderHook(() => useMessageOutbox("s1", { history: () => [{ type: "userMessage", id: "other", clientMessageId: "different", text: "继续", at: 1 }] }));
    await act(async () => {});
    expect(result.current.uncertain).toBe(true);
    act(() => result.current.beginNewPrompt());
    expect(result.current.uncertain).toBe(false);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ id: "m1", text: "继续", state: "uncertain" });
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true });
    act(() => result.current.setInput("继续"));
    await act(() => result.current.submit());
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.sendMessage).mock.calls[0]![2]).not.toBe("m1");
  });
  test.each(["accepted", "failed"] as const)("旧消息的迟到 %s 回执不能删除用户已开始编辑的新草稿", async (state) => {
    localStorage.setItem("agentlink-outbox:s1", JSON.stringify({ id: "m1", text: "旧指令", state: "uncertain" }));
    let finish!: (value: Awaited<ReturnType<typeof api.messageReceipt>>) => void;
    vi.mocked(api.messageReceipt).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useMessageOutbox("s1"));
    act(() => { result.current.beginNewPrompt(); result.current.setInput("我的新草稿"); });
    await act(async () => { finish({ receipt: { clientMessageId: "m1", state, updatedAt: 2, error: null } }); });
    expect(result.current.input).toBe("我的新草稿");
    expect(result.current.uncertain).toBe(false);
    expect(result.current.messages[0]?.state).toBe(state);
    expect(result.current.notice).toBe(state === "accepted" ? "旧指令已确认接收，新草稿已保留" : "旧指令发送失败，新草稿已保留");
    expect(JSON.parse(localStorage.getItem("agentlink-outbox:s1")!).text).toBe("我的新草稿");
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  test("后台暂停核对，返回前台立即核对并在前台重试，退出后清理监听器和定时器", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    localStorage.setItem("agentlink-outbox:s1", JSON.stringify({ id: "m1", text: "继续", state: "uncertain" }));
    vi.mocked(api.messageReceipt).mockResolvedValueOnce({ receipt: { clientMessageId: "m1", state: "uncertain", updatedAt: 1, error: null } })
      .mockResolvedValue({ receipt: { clientMessageId: "m1", state: "accepted", updatedAt: 2, error: null } });
    const { result, unmount } = renderHook(() => useMessageOutbox("s1"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(api.messageReceipt).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.uncertain).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(result.current.uncertain).toBe(false);
    unmount(); window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.messageReceipt).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  test("等待 HTTP 回执时立即显示发送记录；接收后直到桌面同步仍保留，重开可恢复", async () => {
    let confirm!: (value: { ok: true }) => void;
    vi.mocked(api.sendMessage).mockReturnValueOnce(new Promise((resolve) => { confirm = resolve; }));
    const { result, unmount } = renderHook(() => useMessageOutbox("s1"));
    act(() => result.current.setInput("立即显示"));
    let sending!: Promise<void>;
    act(() => { sending = result.current.submit(); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ text: "立即显示", state: "sending" });
    const id = result.current.messages[0]!.id;
    await act(async () => { confirm({ ok: true }); await sending; });
    expect(result.current.messages[0]).toMatchObject({ id, state: "accepted" });
    unmount();
    const reopened = renderHook(() => useMessageOutbox("s1"));
    expect(reopened.result.current.messages[0]).toMatchObject({ id, text: "立即显示", state: "accepted" });
  });
  test("HTTP 回执丢失但电脑已接收，查询确认成功，不能再次发送", async () => {
    vi.mocked(api.sendMessage).mockRejectedValueOnce(new Error("network error"));
    vi.mocked(api.messageReceipt).mockResolvedValueOnce({ receipt: { clientMessageId: "m", state: "accepted", updatedAt: 1, error: null } });
    const { result } = renderHook(() => useMessageOutbox("s1"));
    act(() => result.current.setInput("继续"));
    await act(() => result.current.submit());
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.input).toBe(""); expect(result.current.notice).toBe("电脑端已接收");
  });
  test("明确失败重试保留 ID；同文本下一次发送使用新 ID", async () => {
    vi.mocked(api.sendMessage).mockRejectedValueOnce(new Error("rejected"));
    vi.mocked(api.messageReceipt).mockResolvedValueOnce({ receipt: { clientMessageId: "m", state: "failed", updatedAt: 1, error: "rejected" } });
    const { result } = renderHook(() => useMessageOutbox("s1"));
    act(() => result.current.setInput("继续"));
    await act(() => result.current.submit());
    const id = vi.mocked(api.sendMessage).mock.calls[0]![2];
    expect(result.current.input).toBe("继续");
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true });
    await act(() => result.current.submit());
    expect(vi.mocked(api.sendMessage).mock.calls[1]![2]).toBe(id);
    act(() => result.current.setInput("继续"));
    await act(() => result.current.submit());
    expect(vi.mocked(api.sendMessage).mock.calls[2]![2]).not.toBe(id);
  });
  test("页面重开保留草稿和未确认 ID，只核对结果而不自动重发", async () => {
    localStorage.setItem("agentlink-outbox:s1", JSON.stringify({ text: "重要任务", id: "m1", state: "sending" }));
    vi.mocked(api.messageReceipt).mockResolvedValue({ receipt: { clientMessageId: "m1", state: "uncertain", updatedAt: 1, error: null } });
    const { result } = renderHook(() => useMessageOutbox("s1"));
    expect(result.current.input).toBe("重要任务"); expect(result.current.uncertain).toBe(true);
    await act(() => result.current.submit());
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.messageReceipt).toHaveBeenCalledWith("s1", "m1");
  });
  test("权威历史匹配后删除本地占位，后续历史裁剪及重开都不能让旧记录再冒出来", async () => {
    localStorage.setItem("agentlink-messages:s1", JSON.stringify([{ id: "m1", text: "继续", at: 1, state: "accepted", afterId: "old-anchor", knownUserIds: [] }]));
    const { result, rerender, unmount } = renderHook(({ history }) => useMessageOutbox("s1", { history: () => history }), {
      initialProps: { history: [{ type: "userMessage" as const, id: "server", clientMessageId: "m1", text: "继续", at: 1 }] },
    });
    expect(result.current.messages).toEqual([]);
    expect(JSON.parse(localStorage.getItem("agentlink-messages:s1")!)).toEqual([]);
    rerender({ history: [] });
    expect(result.current.messages).toEqual([]);
    unmount();
    expect(renderHook(() => useMessageOutbox("s1")).result.current.messages).toEqual([]);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  test("旧锚点缺失不能冒充已同步；清除已接收的本地提示不影响草稿或未确认记录", async () => {
    localStorage.setItem("agentlink-outbox:s1", JSON.stringify({ text: "待确认草稿", id: "pending", state: "uncertain" }));
    const records = [
      { id: "old", text: "继续", at: 1, state: "accepted", afterId: "missing", knownUserIds: [] },
      { id: "pending", text: "待确认草稿", at: 2, state: "uncertain", afterId: "missing", knownUserIds: [] },
    ];
    localStorage.setItem("agentlink-messages:s1", JSON.stringify(records));
    const { result } = renderHook(() => useMessageOutbox("s1", { history: () => [{ id: "reply", type: "agentMessage", text: "新回复", at: 2 }] }));
    await act(async () => {});
    expect(result.current.messages).toHaveLength(2);
    act(() => result.current.forgetAccepted(["old", "pending"]));
    expect(result.current.messages.map((m) => m.id)).toEqual(["pending"]);
    expect(result.current.input).toBe("待确认草稿");
    expect(result.current.uncertain).toBe(true);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
