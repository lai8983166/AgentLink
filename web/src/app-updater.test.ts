import { describe, expect, test, vi } from "vitest";
import { createAppUpdater, type AppUpdateState } from "./app-updater";

function setup(timeoutMs = 2000) {
  const owner = Object.assign(new EventTarget(), { state: "activated", postMessage: vi.fn() });
  const next = Object.assign(new EventTarget(), { state: "installing", postMessage: vi.fn() });
  const reg = Object.assign(new EventTarget(), {
    active: owner as unknown as ServiceWorker | null,
    installing: null as ServiceWorker | null, waiting: null as ServiceWorker | null,
    update: vi.fn(async () => reg as unknown as ServiceWorkerRegistration),
  });
  const workers = Object.assign(new EventTarget(), {
    controller: owner as unknown as ServiceWorker,
    register: vi.fn(async () => reg as unknown as ServiceWorkerRegistration),
  });
  const state: AppUpdateState = { build: "old", latestBuild: null, available: false, checking: false, applying: false, error: null, checked: false };
  const version = vi.fn(async () => "old");
  const reload = vi.fn();
  const updater = createAppUpdater({ build: "old", workers: workers as unknown as ServiceWorkerContainer, version,
    reload, publish: (patch) => Object.assign(state, patch), timeoutMs });
  function activate() {
    reg.active = next as unknown as ServiceWorker; reg.waiting = null; reg.installing = null;
    next.state = "activated"; workers.controller = next as unknown as ServiceWorker;
    next.dispatchEvent(new Event("statechange")); workers.dispatchEvent(new Event("controllerchange"));
  }
  return { updater, state, version, reload, workers, reg, next, activate };
}

describe("安装版应用更新", () => {
  test("检查最新版本使用绕过 HTTP 缓存的注册方式，不重载页面", async () => {
    const h = setup(); expect(await h.updater.check()).toBe(true);
    expect(h.workers.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(h.state).toMatchObject({ latestBuild: "old", available: false, checked: true, checking: false });
    expect(h.reload).not.toHaveBeenCalled();
  });
  test("下载并自动启用新版缓存不会打断页面，显式更新才重载", async () => {
    const h = setup(); h.version.mockResolvedValue("new"); h.reg.update.mockImplementation(async () => {
      h.activate(); return h.reg as unknown as ServiceWorkerRegistration;
    });
    await h.updater.check();
    expect(h.state.available).toBe(true); expect(h.reload).not.toHaveBeenCalled();
    await h.updater.apply(); expect(h.reload).toHaveBeenCalledTimes(1);
  });
  test("兼容等待中的旧注册，激活成功后重载；并发点击不重复更新", async () => {
    const h = setup(); h.reg.waiting = h.next as unknown as ServiceWorker; h.next.state = "installed";
    h.next.postMessage.mockImplementation(h.activate);
    const first = h.updater.apply(); const second = h.updater.apply();
    expect(second).toBe(first);
    await first;
    expect(h.next.postMessage).toHaveBeenCalledTimes(1);
    expect(h.next.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(h.reload).toHaveBeenCalledTimes(1); expect(h.state.applying).toBe(false);
  });
  test("文件还在下载时不能重载，等到安装并控制当前页面后才完成", async () => {
    const h = setup(); h.version.mockResolvedValue("new"); h.reg.installing = h.next as unknown as ServiceWorker;
    h.next.postMessage.mockImplementation(h.activate);
    const pending = h.updater.apply();
    await vi.waitFor(() => expect(h.reg.update).toHaveBeenCalled());
    expect(h.reload).not.toHaveBeenCalled();
    h.reg.waiting = h.next as unknown as ServiceWorker; h.next.state = "installed";
    h.next.dispatchEvent(new Event("statechange"));
    await pending; expect(h.reload).toHaveBeenCalledTimes(1);
  });
  test("自动激活过渡阶段等待 controller，避免仍使用旧缓存时重载", async () => {
    const h = setup(500); h.reg.installing = h.next as unknown as ServiceWorker;
    const pending = h.updater.apply();
    await vi.waitFor(() => expect(h.reg.update).toHaveBeenCalled());
    h.reg.installing = null; h.reg.active = h.next as unknown as ServiceWorker;
    h.next.state = "activating"; h.next.dispatchEvent(new Event("statechange"));
    expect(h.reload).not.toHaveBeenCalled();
    h.activate(); await pending;
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
  test("离线失败不宣称最新版、不重载；恢复后可再检查", async () => {
    const h = setup(); h.version.mockRejectedValueOnce(new Error("offline"));
    await h.updater.apply();
    expect(h.state.error).toContain("网络"); expect(h.state.checked).toBe(false);
    expect(h.reload).not.toHaveBeenCalled();
    expect(await h.updater.check()).toBe(true); expect(h.state.error).toBeNull();
  });
  test("注册失败后允许重试，不缓存永久失败的注册 Promise", async () => {
    const h = setup(); h.workers.register.mockRejectedValueOnce(new Error("blocked"));
    expect(await h.updater.check()).toBe(false);
    expect(await h.updater.check()).toBe(true);
    expect(h.workers.register).toHaveBeenCalledTimes(2); expect(h.state.error).toBeNull();
  });
  test("新版安装失败和启用超时不重载，解除忙碌状态可重试", async () => {
    const h = setup(500); h.reg.installing = h.next as unknown as ServiceWorker;
    const pending = h.updater.apply();
    await vi.waitFor(() => expect(h.reg.update).toHaveBeenCalled());
    h.next.state = "redundant"; h.next.dispatchEvent(new Event("statechange"));
    await pending; expect(h.state.error).toContain("安装失败");
    h.reg.installing = null; h.next.state = "installed"; h.reg.waiting = h.next as unknown as ServiceWorker;
    await h.updater.apply(); expect(h.state.error).toContain("超时");
    expect(h.reload).not.toHaveBeenCalled(); expect(h.state.applying).toBe(false);
    h.next.postMessage.mockImplementation(h.activate);
    await h.updater.apply(); expect(h.reload).toHaveBeenCalledTimes(1);
  });
  test("浏览器的更新请求无响应时解除检查状态，后续允许重试", async () => {
    const h = setup(50);
    h.reg.update.mockReturnValueOnce(new Promise(() => {}));
    expect(await h.updater.check()).toBe(false);
    expect(h.state.checking).toBe(false); expect(h.reload).not.toHaveBeenCalled();
    expect(await h.updater.check()).toBe(true);
  });
  test("并发检查合并请求，没有 SW 的普通网页也能检查及重载", async () => {
    let resolve!: (build: string) => void;
    const version = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const publish = vi.fn(), reload = vi.fn();
    const updater = createAppUpdater({ build: "old", version, publish, reload });
    const first = updater.check(), second = updater.check();
    expect(second).toBe(first); resolve("new"); await first;
    expect(version).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ latestBuild: "new", available: true });
    expect(reload).not.toHaveBeenCalled();
    const pending = updater.apply(); resolve("new"); await pending;
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
