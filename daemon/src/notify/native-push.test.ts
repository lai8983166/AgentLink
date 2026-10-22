import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PushStore } from "./push-store";
import { WebPushService } from "./web-push";
import { createNativePushRouter } from "../routes/native-push";

const event = (status: "running" | "done" | "error") => ({ type: "session.status" as const, sessionId: "test-thread", status, activity: null, seq: 1, at: 1 });
describe("安卓通知收件箱", () => {
  test("未认证不可注册，终态仅入队一次，读取不确认，确认只能删除本设备通知", async () => {
    let webCalls = 0;
    const push = new WebPushService(new PushStore(), async () => { webCalls++; });
    try {
      const app = createNativePushRouter(push, { token: "test-token" });
      const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
      const id = randomUUID(), other = randomUUID();
      expect((await app.request("/api/v1/native-push/devices", { method: "POST", body: JSON.stringify({ id }) })).status).toBe(401);
      for (const device of [id, other]) expect((await app.request("/api/v1/native-push/devices", { method: "POST", headers, body: JSON.stringify({ id: device }) })).status).toBe(200);
      push.onEvent(event("done")); expect(push.store.status(id)?.pending).toBe(0);
      push.onEvent(event("running")); push.onEvent(event("done")); push.onEvent(event("done")); await push.flush();
      expect(webCalls).toBe(0);
      const res = await app.request(`/api/v1/native-push/devices/${id}/inbox?wait=0`, { headers });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const { deliveries } = await res.json();
      expect(deliveries).toHaveLength(1); expect(deliveries[0].notification.url).toBe("/test-thread");
      expect(push.store.status(id)?.pending).toBe(1);
      const ack = (device: string) => app.request(`/api/v1/native-push/devices/${device}/ack`, { method: "POST", headers, body: JSON.stringify({ ids: [deliveries[0].id] }) });
      await ack(other); expect(push.store.status(id)?.pending).toBe(1);
      await ack(id); await ack(id); expect(push.store.status(id)?.pending).toBe(0);
      expect(push.store.status(other)?.pending).toBe(1);
      await app.request(`/api/v1/native-push/devices/${other}`, { method: "DELETE", headers });
      expect(push.store.isNative(other)).toBe(false);
      expect((await app.request(`/api/v1/native-push/devices/${other}/inbox?wait=0`, { headers })).status).toBe(404);
    } finally { await push.close(); }
  });
  test("长轮询被新通知唤醒，网络取消可退出，重启后仍能补收，过期不投递", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "native-inbox-")), "push.db");
    const id = randomUUID(); let now = 1000;
    const a = new WebPushService(new PushStore(path), async () => {}, () => now);
    a.store.registerNative(id);
    const controller = new AbortController();
    const canceled = a.nativeInbox(id, controller.signal); controller.abort(); expect(await canceled).toEqual([]);
    const waiting = a.nativeInbox(id); a.onEvent(event("running")); a.onEvent(event("error"));
    expect(await waiting).toHaveLength(1); await a.close();
    const b = new WebPushService(new PushStore(path), async () => {}, () => now);
    try {
      const jobs = await b.nativeInbox(id, undefined, 0); expect(jobs).toHaveLength(1);
      b.onEvent(event("error")); expect((await b.nativeInbox(id, undefined, 0))[0]?.id).toBe(jobs[0]?.id);
      now += 86400001; expect(await b.nativeInbox(id, undefined, 0)).toEqual([]);
      expect(b.store.status(id)?.lastError).toContain("24 小时");
      b.store.revokeAll(); expect(b.store.isNative(id)).toBe(false);
    } finally { await b.close(); }
  });
});
