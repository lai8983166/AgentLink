import { Hono } from "hono";
import { API } from "@agentlink/shared";

export const DAEMON_VERSION = "0.1.0";

/** 装配 Hono 应用（REST/WS/静态由后续任务接入） */
export function createApp(): Hono {
  const app = new Hono();

  // 健康检查：无需认证（remote-access spec）
  app.get(API.health, (c) =>
    c.json({ ok: true, daemon: "agentlink", version: DAEMON_VERSION }),
  );

  return app;
}
