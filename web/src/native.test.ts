import { describe, expect, it, vi } from "vitest";
import { normalizeServerUrl, notificationPath } from "./native";
import { ApiClient } from "./api/client";

describe("安卓连接边界", () => {
  it("服务器地址必须是 HTTPS origin，不接受凭据、路径、参数", () => {
    expect(normalizeServerUrl(" https://agentlink.example:8443/ ")).toBe("https://agentlink.example:8443");
    for (const value of ["http://localhost:8799", "https://user:token@example.com", "https://example.com/api", "https://example.com/?token=x", "https://example.com/#x"]) expect(() => normalizeServerUrl(value)).toThrow();
  });
  it("通知只能返回内部会话或设置，不能打开外站和 API", () => {
    expect(notificationPath("/thread-123")).toBe("/thread-123"); expect(notificationPath("/settings")).toBe("/settings");
    for (const path of ["https://evil.example", "//evil.example", "/api/v1/status", "/../settings", "/thread?token=x"]) expect(notificationPath(path)).toBeNull();
  });
  it("API 在请求时读取服务器地址，重新配对后不会沿用旧地址", async () => {
    let base = "https://first.example";
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      const client = new ApiClient(() => base, () => "test-token"); await client.status();
      base = "https://second.example"; await client.status();
      expect(fetcher.mock.calls[0]?.[0]).toBe("https://first.example/api/v1/status");
      expect(fetcher.mock.calls[1]?.[0]).toBe("https://second.example/api/v1/status");
    } finally { fetcher.mockRestore(); }
  });
});
