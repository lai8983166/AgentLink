import { Hono } from "hono";
import { PushSubscriptionInput } from "@agentlink/shared";
import type { WebPushService } from "../notify/web-push";
import { authMiddleware } from "./api";

export function createPushRouter(push: WebPushService, auth: { token: string }): Hono {
  const api = new Hono();
  api.use("/api/v1/push/*", authMiddleware(auth));
  api.use("/api/v1/push/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  api.get("/api/v1/push/config", (c) => c.json({ publicKey: push.publicKey, device: push.store.status(c.req.query("deviceId") ?? "") }));
  api.post("/api/v1/push/subscriptions", async (c) => {
    const input = PushSubscriptionInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "推送订阅无效，请重新开启通知" } }, 400);
    try {
      const id = push.subscribe(input.data);
      return c.json({ device: push.store.status(id) });
    } catch { return c.json({ error: { code: "VALIDATION_ERROR", message: "不支持此浏览器的推送地址，请使用支持 Web Push 的浏览器" } }, 400); }
  });
  api.delete("/api/v1/push/subscriptions/:id", (c) => { push.store.remove(c.req.param("id")); return c.json({ ok: true }); });
  api.post("/api/v1/push/subscriptions/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!push.store.status(id)) return c.json({ error: { code: "VALIDATION_ERROR", message: "通知订阅已失效，请重新开启" } }, 400);
    await push.test(id);
    return c.json({ device: push.store.status(id) });
  });
  return api;
}
