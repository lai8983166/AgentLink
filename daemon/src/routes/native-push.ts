import { Hono } from "hono";
import { NativeAckInput, NativeDeviceInput } from "@agentlink/shared";
import type { WebPushService } from "../notify/web-push";
import { authMiddleware } from "./api";

export function createNativePushRouter(push: WebPushService, auth: { token: string }): Hono {
  const api = new Hono();
  api.use("/api/v1/native-push/*", authMiddleware(auth));
  api.use("/api/v1/native-push/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  api.post("/api/v1/native-push/devices", async (c) => {
    const input = NativeDeviceInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "安卓设备编号无效" } }, 400);
    push.store.registerNative(input.data.id);
    return c.json({ device: push.store.status(input.data.id) });
  });
  api.use("/api/v1/native-push/devices/:id/*", async (c, next) => {
    if (!push.store.isNative(c.req.param("id")!)) return c.json({ error: { code: "NOT_FOUND", message: "请重新开启安卓通知" } }, 404);
    await next();
  });
  api.get("/api/v1/native-push/devices/:id/inbox", async (c) => {
    const deliveries = await push.nativeInbox(c.req.param("id"), c.req.raw.signal, c.req.query("wait") === "0" ? 0 : 20000);
    // 长轮询期间也可能轮换 token，绝不能返回旧配对下的通知。
    if (c.req.header("Authorization") !== `Bearer ${auth.token}`) return c.json({ error: { code: "UNAUTHORIZED", message: "请重新配对" } }, 401);
    return c.json({ deliveries });
  });
  api.post("/api/v1/native-push/devices/:id/ack", async (c) => {
    const input = NativeAckInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "通知确认无效" } }, 400);
    push.store.acknowledgeNative(c.req.param("id"), input.data.ids, Date.now());
    return c.json({ ok: true });
  });
  api.post("/api/v1/native-push/devices/:id/test", async (c) => {
    await push.test(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.delete("/api/v1/native-push/devices/:id", (c) => {
    if (push.store.isNative(c.req.param("id"))) push.store.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  return api;
}
