import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useMessageOutbox } from "./message-outbox";
import { api } from "./runtime";
vi.mock("./runtime", () => ({ api: { sendMessage: vi.fn(), messageReceipt: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);
describe("手机指令草稿与回执", () => {
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
});
