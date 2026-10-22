import { describe, expect, test, vi } from "vitest";
import { runInNewContext } from "node:vm";
import source from "../public/push-worker.js?raw";

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const self = { addEventListener: (name: string, fn: (event: any) => void) => { handlers[name] = fn; }, location: { origin: "https://agent.test" },
    registration: { showNotification: vi.fn().mockResolvedValue(undefined) },
    clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn().mockResolvedValue(null) } };
  runInNewContext(source, { self, URL });
  const dispatch = async (name: string, event: object) => { let pending: Promise<unknown> | undefined; handlers[name]!({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } }); await pending; };
  return { self, dispatch };
}
describe("后台推送 Service Worker", () => {
  test("页面不在运行时仍展示通知，重试同 tag 不反复响铃", async () => {
    const { self, dispatch } = worker();
    await dispatch("push", { data: { json: () => ({ title: "任务完成", body: "点击查看", tag: "turn-1", url: "/s1" }) } });
    expect(self.registration.showNotification).toHaveBeenCalledWith("任务完成", expect.objectContaining({ tag: "turn-1", renotify: false, data: { url: "/s1" } }));
  });
  test("无效消息仍产生可见通知，不把解析失败当成静默成功", async () => {
    const { self, dispatch } = worker(); await dispatch("push", { data: { json: () => { throw new Error("bad json"); } } });
    expect(self.registration.showNotification).toHaveBeenCalledWith("AgentLink", expect.objectContaining({ body: expect.any(String) }));
  });
  test("点击只打开同源会话或设置页，拒绝外站和 API 地址", async () => {
    for (const url of ["https://evil.test", "//evil.test", "/api/v1/status"]) {
      const { self, dispatch } = worker();
      await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url } } });
      expect(self.clients.openWindow).toHaveBeenCalledWith("https://agent.test/");
    }
    const { self, dispatch } = worker(); await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/s1" } } });
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://agent.test/s1");
  });
  test("已有窗口时导航并聚焦原窗口", async () => {
    const { self, dispatch } = worker(); const client = { url: "https://agent.test/", navigate: vi.fn().mockResolvedValue({}), focus: vi.fn().mockResolvedValue({}) };
    self.clients.matchAll.mockResolvedValue([client]);
    await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/s2" } } });
    expect(client.navigate).toHaveBeenCalledWith("https://agent.test/s2"); expect(client.focus).toHaveBeenCalled(); expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
});
