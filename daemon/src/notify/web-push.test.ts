import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import type { SessionEvent } from "@agentlink/shared";
import { PushStore } from "./push-store";
import { WebPushService, validPushEndpoint, sendWebPush, type PushSender } from "./web-push";
import webpush from "web-push";
import { createPushRouter } from "../routes/push";

function subscription() {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
const event = (status: "running" | "done" | "error" | "unknown" | "idle" | "waiting_approval"): SessionEvent => ({ type: "session.status", sessionId: "s1", status, activity: null, seq: 1, at: 1 });
const services: WebPushService[] = [];
function service(send: PushSender = async () => {}, path?: string, now?: () => number) {
  const push = new WebPushService(new PushStore(path), send, now); services.push(push); return push;
}
afterEach(async () => { await Promise.all(services.splice(0).map((s) => s.close())); });

describe("AgentLink Web Push", () => {
  test("通知落盘失败不能中断模型事件，恢复后重复状态可以重新记录", async () => {
    let calls = 0; const push = service(async () => { calls++; }); push.subscribe(subscription());
    const original = push.store.taskStatus.bind(push.store);
    push.store.taskStatus = () => { throw new Error("disk failure"); };
    expect(() => push.onEvent(event("running"))).not.toThrow();
    push.store.taskStatus = original;
    push.onEvent(event("running")); push.onEvent(event("done")); await push.flush(); expect(calls).toBe(1);
  });
  test("发送使用标准加密和 VAPID，明确限制总等待时间且禁止重定向", async () => {
    const original = globalThis.fetch; const keys = webpush.generateVAPIDKeys();
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => { sent = init; return new Response("", { status: 201 }); }) as typeof fetch;
    try {
      await sendWebPush(subscription(), "private notification", { vapidDetails: { ...keys, subject: "https://agentlink.test" } });
      expect(sent?.redirect).toBe("error"); expect(sent?.signal).toBeDefined();
      expect((sent?.headers as Record<string, string>)["Content-Encoding"]).toBe("aes128gcm");
      expect(Buffer.from(sent?.body as Uint8Array).toString()).not.toContain("private notification");
    } finally { globalThis.fetch = original; }
  });
  test("首次打开旧完成记录不通知，真实一轮完成只通知一次，下一轮仍通知", async () => {
    const sent: string[] = []; const push = service(async (_, payload) => { sent.push(payload); });
    push.subscribe(subscription());
    push.onEvent(event("done")); await push.flush(); expect(sent).toHaveLength(0);
    push.onEvent(event("running")); push.onEvent(event("running")); push.onEvent(event("waiting_approval"));
    push.onEvent(event("done")); push.onEvent(event("done")); await push.flush();
    expect(sent).toHaveLength(1); expect(JSON.parse(sent[0]!)).toMatchObject({ title: "AgentLink · 任务完成", url: "/s1" });
    push.onEvent(event("running")); push.onEvent(event("error")); await push.flush();
    expect(sent).toHaveLength(2); expect(JSON.parse(sent[1]!).title).toContain("出错");
  });
  test("失联不是完成，重连完成仍通知；明确中止后不误报成功", async () => {
    let calls = 0; const push = service(async () => { calls++; }); push.subscribe(subscription());
    push.onEvent(event("running")); push.onEvent(event("unknown")); await push.flush(); expect(calls).toBe(0);
    push.onEvent(event("done")); await push.flush(); expect(calls).toBe(1);
    push.onEvent(event("running")); push.onEvent(event("idle")); push.onEvent(event("done")); await push.flush(); expect(calls).toBe(1);
  });
  test("私钥及订阅持久化，重启不重发已结束轮次，后台退出期间完成可核对", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentlink-push-")), "push.db");
    const a = service(undefined, path); const id = a.subscribe(subscription()); const publicKey = a.publicKey;
    a.onEvent(event("running")); await a.close(); services.splice(services.indexOf(a), 1);
    let calls = 0; const b = service(async () => { calls++; }, path);
    expect(b.publicKey).toBe(publicKey); expect(b.store.status(id)).not.toBeNull();
    b.onEvent(event("done")); await b.flush(); expect(calls).toBe(1);
    await b.close(); services.splice(services.indexOf(b), 1);
    const c = service(async () => { calls++; }, path); c.onEvent(event("done")); await c.flush(); expect(calls).toBe(1);
  });
  test("服务失败保留队列，按退避重试，通知 tag/topic 不变且不包含认证令牌", async () => {
    let now = 1000; const attempts: Array<{ payload: string; topic: string | undefined }> = [];
    const push = service(async (_, payload, options) => { attempts.push({ payload, topic: options.topic }); if (attempts.length === 1) throw { statusCode: 503 }; }, undefined, () => now);
    const id = push.subscribe(subscription()); push.onEvent(event("running")); push.onEvent(event("done")); await push.flush();
    expect(push.store.status(id)).toMatchObject({ lastAcceptedAt: null, pending: 1 });
    await push.flush(); expect(attempts).toHaveLength(1);
    now += 2001; await push.flush(); expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
    expect(push.store.status(id)).toMatchObject({ lastAcceptedAt: now, lastError: null, pending: 0 });
    expect(attempts[0]?.payload).not.toContain("privateKey");
  });
  test.each([404, 410])("推送服务返回 %s 时移除失效订阅与队列", async (statusCode) => {
    const push = service(async () => { throw { statusCode }; }); const id = push.subscribe(subscription());
    await push.test(id); expect(push.store.status(id)).toBeNull(); expect(push.store.due(Date.now())).toHaveLength(0);
  });
  test("关闭通知或轮换配对后，未发通知被撤销，新设备不补发旧通知", async () => {
    let calls = 0; const push = service(async () => { calls++; });
    const id = push.subscribe(subscription()); push.store.enqueue("old", "{}", Date.now(), id); push.store.remove(id);
    await push.flush(); expect(calls).toBe(0);
    push.subscribe(subscription()); push.store.enqueue("new", "{}", Date.now()); push.store.revokeAll();
    await push.flush(); expect(calls).toBe(0);
    const newId = push.subscribe(subscription()); expect(push.store.status(newId)?.pending).toBe(0);
  });
  test("订阅地址限制到支持的 HTTPS 推送服务，不能请求本机/任意站点", () => {
    for (const endpoint of ["http://fcm.googleapis.com/send/x", "https://127.0.0.1/", "https://fcm.googleapis.com.evil.test/", "https://fcm.googleapis.com@evil.test/", "https://fcm.googleapis.com:999/", "https://example.com/"]) expect(validPushEndpoint(endpoint)).toBe(false);
    expect(validPushEndpoint(subscription().endpoint)).toBe(true);
    expect(validPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/a")).toBe(true);
  });
  test("REST 要求配对、仅返回公钥和本机状态，测试发送不执行任何任务", async () => {
    let calls = 0; const push = service(async () => { calls++; }); const app = createPushRouter(push, { token: "t" });
    expect((await app.request("/api/v1/push/config")).status).toBe(401);
    const headers = { Authorization: "Bearer t", "Content-Type": "application/json" };
    const config = await app.request("/api/v1/push/config", { headers });
    expect(config.headers.get("Cache-Control")).toBe("no-store"); expect(await config.json()).toEqual({ publicKey: push.publicKey, device: null });
    const invalid = await app.request("/api/v1/push/subscriptions", { method: "POST", headers, body: JSON.stringify({ ...subscription(), endpoint: "https://localhost/" }) }); expect(invalid.status).toBe(400);
    const res = await app.request("/api/v1/push/subscriptions", { method: "POST", headers, body: JSON.stringify(subscription()) });
    const { device } = await res.json(); expect(device.id).toBeTruthy(); expect(device).not.toHaveProperty("endpoint");
    const test = await app.request(`/api/v1/push/subscriptions/${device.id}/test`, { method: "POST", headers });
    expect((await test.json()).device.lastAcceptedAt).toBeNumber(); expect(calls).toBe(1);
  });
});
