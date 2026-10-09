import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiClient } from "./client";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("HTTP 请求不会无限等待", () => {
  test("网络不响应时超时报错，保留操作结果待核对的含义", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const client = new ApiClient("", () => "test", { timeoutMs: 100 });
    const assertion = expect(client.sendMessage("s1", "hello", "m1")).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });
});
