import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectWs, queryClient, ws } from "./runtime";

beforeEach(() => {
  vi.spyOn(ws, "connect").mockImplementation(() => {});
  vi.spyOn(ws, "disconnect").mockImplementation(() => {});
  vi.spyOn(ws, "probe").mockImplementation(() => {});
  vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("手机恢复时主动刷新权威状态", () => {
  test("网络重连同时刷新首页和会话详情", () => {
    const cleanup = connectWs();
    ws.onStateChange("open");
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session"] });
    cleanup();
  });

  test("从后台回到手机页面立即探测和刷新，退出后移除监听器", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const cleanup = connectWs();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ws.probe).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    cleanup();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ws.probe).toHaveBeenCalledTimes(1);
  });
});
