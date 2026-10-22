import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./runtime";
import { boundedPush, disablePush, enablePush, inspectPush, publicKeyBytes, pushSupportError } from "./push-client";
vi.mock("./runtime", () => ({ api: { pushConfig: vi.fn(), pushSubscribe: vi.fn(), pushRemove: vi.fn() } }));
const key = btoa(String.fromCharCode(...new Uint8Array(65).fill(1))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const device = { id: "d1", lastAcceptedAt: null, lastError: null, pending: 0 };
let reg: { pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } };
let sub: { options: { applicationServerKey: ArrayBuffer }; unsubscribe: ReturnType<typeof vi.fn>; toJSON: () => object };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.stubGlobal("isSecureContext", true); vi.stubGlobal("PushManager", function () {});
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn().mockResolvedValue("granted") });
  sub = { options: { applicationServerKey: publicKeyBytes(key).buffer }, unsubscribe: vi.fn().mockResolvedValue(true), toJSON: () => ({ endpoint: "https://fcm.googleapis.com/send/x", keys: { p256dh: key, auth: "auth-key" } }) };
  reg = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockResolvedValue(sub) } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(reg), getRegistration: vi.fn().mockResolvedValue(reg) } });
  vi.mocked(api.pushConfig).mockResolvedValue({ publicKey: key, device: null });
  vi.mocked(api.pushSubscribe).mockResolvedValue({ device });
  vi.mocked(api.pushRemove).mockResolvedValue({ ok: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("系统推送订阅", () => {
  test("检查状态不会弹出权限框或自动订阅，不安全网址明确说明", async () => {
    expect(pushSupportError()).toBeNull();
    expect((await inspectPush()).active).toBe(false);
    expect(Notification.requestPermission).not.toHaveBeenCalled(); expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    vi.stubGlobal("isSecureContext", false); expect(pushSupportError()).toContain("HTTPS");
  });
  test("开启首先请求用户授权，随后订阅并保存设备，重复开启复用订阅", async () => {
    const pending = enablePush(key); expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect((await pending).active).toBe(true);
    expect(localStorage.getItem("agentlink-push-device")).toBe("d1");
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(key) });
    reg.pushManager.getSubscription.mockResolvedValue(sub);
    await enablePush(key); expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });
  test("拒绝权限不创建或上传订阅；服务端注册失败不伪造开启", async () => {
    vi.mocked(Notification.requestPermission).mockResolvedValueOnce("denied");
    await expect(enablePush(key)).rejects.toThrow("未获得通知权限"); expect(api.pushSubscribe).not.toHaveBeenCalled();
    vi.mocked(api.pushSubscribe).mockRejectedValueOnce(new Error("offline"));
    await expect(enablePush(key)).rejects.toThrow("offline"); expect(localStorage.getItem("agentlink-push-device")).toBeNull();
  });
  test("权限与订阅仍在但后台已撤销时不显示为开启；VAPID 变更先退旧订阅", async () => {
    localStorage.setItem("agentlink-push-device", "old"); reg.pushManager.getSubscription.mockResolvedValue(sub);
    expect((await inspectPush()).active).toBe(false);
    sub.options.applicationServerKey = new Uint8Array(65).fill(2).buffer;
    await enablePush(key); expect(sub.unsubscribe).toHaveBeenCalledTimes(1); expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });
  test("关闭先撤销后台，再退浏览器订阅；离线失败保留开启信息便于重试", async () => {
    localStorage.setItem("agentlink-push-device", "d1"); reg.pushManager.getSubscription.mockResolvedValue(sub);
    vi.mocked(api.pushRemove).mockRejectedValueOnce(new Error("offline"));
    await expect(disablePush()).rejects.toThrow("offline"); expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem("agentlink-push-device")).toBe("d1");
    await disablePush(); expect(sub.unsubscribe).toHaveBeenCalledTimes(1); expect(localStorage.getItem("agentlink-push-device")).toBeNull();
  });
  test("后台订阅失效后重开会续建浏览器订阅，不反复复用已过期入口", async () => {
    reg.pushManager.getSubscription.mockResolvedValue(sub);
    await enablePush(key, { renew: true });
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1); expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });
  test("不响应的推送服务有等待上限，不报告发送成功", async () => {
    vi.useFakeTimers();
    const assertion = expect(boundedPush(new Promise(() => {}), "开通超时", 100)).rejects.toThrow("开通超时");
    await vi.advanceTimersByTimeAsync(101); await assertion;
  });
});
