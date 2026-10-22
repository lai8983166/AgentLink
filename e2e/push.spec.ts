import { test, expect, type Page } from "@playwright/test";

test.use({ serviceWorkers: "allow" });
test.beforeEach(async ({ page, request, context }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await context.grantPermissions(["notifications"]);
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

/** Real SW registration, local simulated browser subscription; never contact a public push provider. */
async function mockSubscription(page: Page, denied = false) {
  await page.addInitScript((denied) => {
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => denied ? "denied" : "granted" });
    Object.defineProperty(Notification, "requestPermission", { configurable: true, value: async () => denied ? "denied" : "granted" });
    function fromStored() {
      const raw = localStorage.getItem("test-push-subscription"); if (!raw) return null;
      const stored = JSON.parse(raw);
      return { endpoint: stored.endpoint, options: { applicationServerKey: new Uint8Array(stored.serverKey).buffer },
        toJSON: () => ({ endpoint: stored.endpoint, keys: stored.keys }),
        unsubscribe: async () => { localStorage.removeItem("test-push-subscription"); return true; } };
    }
    PushManager.prototype.getSubscription = async () => fromStored() as unknown as PushSubscription;
    PushManager.prototype.subscribe = async (options) => {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      localStorage.setItem("test-push-subscription", JSON.stringify({ endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
        keys: { p256dh: base64(publicKey), auth: base64(crypto.getRandomValues(new Uint8Array(16))) },
        serverKey: Array.from(new Uint8Array(options!.applicationServerKey as ArrayBuffer)) }));
      return fromStored() as unknown as PushSubscription;
    };
  }, denied);
}

test("通知开启、测试与重开状态保留，关闭手机页面后任务完成仍由后台发送", async ({ page, context, request }, testInfo) => {
  await mockSubscription(page);
  await page.goto("/"); await expect(page.getByText("等待审批", { exact: true })).toBeVisible();
  await page.goto("/settings");
  const enable = page.getByRole("button", { name: "开启任务通知", exact: true }); await expect(enable).toBeEnabled(); await enable.click();
  await expect(page.getByText("此设备已开启任务通知")).toBeVisible();
  await page.getByRole("button", { name: "发送测试通知" }).click();
  await expect(page.getByText("推送服务已接受测试通知，请确认手机通知栏是否收到。")).toBeVisible();
  await page.reload(); await expect(page.getByText("此设备已开启任务通知")).toBeVisible();
  await page.getByRole("button", { name: "关闭任务通知" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("push-settings.png") });
  await page.close();
  await request.post("/__test__/control", { data: { type: "done" } });
  await expect.poll(async () => (await (await request.post("/__test__/metrics")).json()).notifications.map((n: { title: string }) => n.title)).toEqual(["AgentLink · 测试通知", "AgentLink · 任务完成"]);
  const metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.notifications[1].url).toBe("/old1"); expect(metrics.sends).toHaveLength(0); expect(metrics.resumeCalls).toBe(0);
  const reopened = await context.newPage(); await mockSubscription(reopened); await reopened.goto("/settings");
  await expect(reopened.getByText("此设备已开启任务通知")).toBeVisible();
  await reopened.getByRole("button", { name: "关闭任务通知" }).click(); await expect(reopened.getByText("已关闭此设备的任务通知")).toBeVisible();
  await request.post("/__test__/control", { data: { type: "running" } }); await request.post("/__test__/control", { data: { type: "done" } });
  expect((await (await request.post("/__test__/metrics")).json()).notifications).toHaveLength(2);
});

test("首次打开历史完成任务和重复快照不轰炸通知，真实下一轮完成才通知", async ({ page, request }) => {
  await mockSubscription(page); await request.post("/__test__/control", { data: { type: "done" } });
  await page.goto("/"); await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await page.goto("/settings"); await page.getByRole("button", { name: "开启任务通知" }).click();
  await expect(page.getByText("此设备已开启任务通知")).toBeVisible();
  await request.post("/__test__/control", { data: { type: "done" } });
  expect((await (await request.post("/__test__/metrics")).json()).notifications).toHaveLength(0);
  await request.post("/__test__/control", { data: { type: "running" } }); await request.post("/__test__/control", { data: { type: "done" } });
  await expect.poll(async () => (await (await request.post("/__test__/metrics")).json()).notifications.length).toBe(1);
  await request.post("/__test__/control", { data: { type: "done" } });
  expect((await (await request.post("/__test__/metrics")).json()).notifications).toHaveLength(1);
});

test("权限拒绝保持未开启，不能注册后台订阅", async ({ page, request }) => {
  await mockSubscription(page, true); await page.goto("/settings");
  await page.getByRole("button", { name: "开启任务通知" }).click();
  await expect(page.getByRole("alert")).toContainText("未获得通知权限");
  expect(await page.evaluate(() => localStorage.getItem("agentlink-push-device"))).toBeNull();
  expect((await (await request.post("/__test__/metrics")).json()).notifications).toHaveLength(0);
});

test("真实 Service Worker 在没有 AgentLink 页面时接收 push 事件并显示通知", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page); let registrationId: string | undefined;
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    registrationId = registrations.find((r) => r.scopeURL === "http://127.0.0.1:48917/" && !r.isDeleted)?.registrationId ?? registrationId;
  });
  await cdp.send("ServiceWorker.enable"); await page.goto("/settings");
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect.poll(() => registrationId).toBeTruthy();
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(() => {
    const sw = globalThis as unknown as { registration: ServiceWorkerRegistration; received: unknown[] };
    sw.received = [];
    sw.registration.showNotification = async (title, options) => { sw.received.push({ title, options }); };
  });
  await page.goto("about:blank");
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: "http://127.0.0.1:48917", registrationId: registrationId!, data: JSON.stringify({ title: "AgentLink · 任务完成", body: "后台消息", url: "/old1", tag: "background-test" }) });
  await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { received: unknown[] }).received)).toEqual([{ title: "AgentLink · 任务完成", options: expect.objectContaining({ data: { url: "/old1" }, renotify: false }) }]);
  await cdp.detach();
});
