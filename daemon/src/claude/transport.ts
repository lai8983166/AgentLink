import { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ClaudeApprovalWait } from "@agentlink/shared";
import type { ClaudeSessions } from "./sessions";
import { errorToResponse } from "../routes/api";

export function claudeRouter(sessions: ClaudeSessions, token: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const expected = Buffer.from("Bearer " + token), actual = Buffer.from(c.req.header("Authorization") ?? "");
    if (c.req.header("Origin") || expected.length !== actual.length || !timingSafeEqual(actual, expected)) return c.json({ error: "Unauthorized" }, 401);
    if (Number(c.req.header("Content-Length") ?? 0) > 8 * 1024 * 1024) return c.json({ error: "Too large" }, 413);
    await next();
  });
  const body = async (request: Request) => {
    const text = await request.text();
    if (text.length > 8 * 1024 * 1024) throw new Error("Payload too large");
    return JSON.parse(text);
  };
  app.post("/exchange", async c => c.json(sessions.exchange(await body(c.req.raw))));
  app.post("/approval/wait", async c => {
    const p = ClaudeApprovalWait.parse(await body(c.req.raw));
    return c.json(await sessions.waitApproval(p.sessionId, p.instanceId, p.approvalId, c.req.raw.signal));
  });
  app.onError((e, c) => e.name === "ZodError" ? c.json({ error: "Invalid Claude protocol" }, 400) : errorToResponse(c, e));
  return app;
}

/** 本机随机端口 + 独立持久凭据。生产公网路由不暴露插件接口。 */
export function startClaudeTransport(sessions: ClaudeSessions, file: string) {
  let token = randomBytes(32).toString("hex");
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, "utf8"));
    if (typeof previous.token === "string" && previous.token.length >= 32) token = previous.token;
  }
  const app = claudeRouter(sessions, token);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 40, maxRequestBodySize: 8 * 1024 * 1024 });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify({ protocol: 1, url: `http://127.0.0.1:${server.port}`, token }), { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return server;
}
