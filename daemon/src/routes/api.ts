import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  API,
  ApprovalDecisionRequest,
  CreateSessionRequest,
  PatchSessionRequest,
  SendMessageRequest,
} from "@agentlink/shared";
import { DaemonError } from "../codex/bridge";
import type { SessionRegistry } from "../domain/sessions";
import type { ApprovalService } from "../domain/approvals";
import type { AuditStore } from "../domain/audit";
import type { FsService } from "../domain/fs";
import { DAEMON_VERSION } from "../server-version";

/** REST API（任务 5.1）：Bearer 认证 + 错误 envelope */

export interface ApiDeps {
  token: string;
  registry: SessionRegistry;
  approvals: ApprovalService;
  audit: AuditStore;
  fs: FsService;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function authMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${token}`) {
      return c.json(errorBody("UNAUTHORIZED", "缺失或无效 token"), 401);
    }
    await next();
  };
}

/** DaemonError → envelope；zod → VALIDATION_ERROR；其余 → INTERNAL */
export function errorToResponse(c: Context, e: unknown) {
  if (e instanceof DaemonError) {
    const status = e.code === "UNAUTHORIZED" ? 401 : e.code.startsWith("SESSION_NOT") || e.code === "APPROVAL_NOT_FOUND" ? 404 : e.code === "VALIDATION_ERROR" ? 400 : e.code === "SESSION_BUSY" || e.code === "APPROVAL_EXPIRED" || e.code === "PATH_NOT_ALLOWED" ? 409 : 500;
    return c.json(errorBody(e.code, e.message), status as 400 | 401 | 404 | 409 | 500);
  }
  console.error("[api] internal error:", e);
  return c.json(errorBody("INTERNAL", "内部错误"), 500);
}

export function createApiRouter(deps: ApiDeps): Hono {
  const api = new Hono();
  // 认证只作用于 /api/v1/*，不影响静态资源与 SPA fallback
  api.use("/api/v1/*", authMiddleware(deps.token));

  api.get(API.status, (c) =>
    c.json({
      daemonVersion: DAEMON_VERSION,
      mode: c.req.header("Host")?.startsWith("127.0.0.1") || c.req.header("Host")?.startsWith("localhost")
        ? "local"
        : "lan",
      latencyMs: null,
      rateLimits: null,
      pendingApprovals: 0,
    }),
  );

  api.get(API.sessions, async (c) => c.json({ sessions: await deps.registry.list() }));

  api.post(API.sessions, async (c) => {
    const body = CreateSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("VALIDATION_ERROR", "请求体不合法"), 400);
    const id = await deps.registry.create(body.data);
    return c.json({ id }, 201);
  });

  api.get("/api/v1/sessions/:id", async (c) => {
    const { session, latestSeq } = await deps.registry.detail(c.req.param("id"));
    return c.json({ session, latestSeq });
  });

  api.post("/api/v1/sessions/:id/resume", async (c) => {
    const session = await deps.registry.resume(c.req.param("id"));
    return c.json({ session });
  });

  api.post("/api/v1/sessions/:id/message", async (c) => {
    const body = SendMessageRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("VALIDATION_ERROR", "请求体不合法"), 400);
    await deps.registry.sendMessage(c.req.param("id"), body.data.text);
    return c.json({ ok: true });
  });

  api.post("/api/v1/sessions/:id/interrupt", async (c) => {
    await deps.registry.interrupt(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.patch("/api/v1/sessions/:id", async (c) => {
    const body = PatchSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("VALIDATION_ERROR", "请求体不合法"), 400);
    deps.registry.setPolicy(c.req.param("id"), body.data.approvalPolicy);
    return c.json({ ok: true });
  });

  api.post("/api/v1/sessions/:id/approvals/:aid", async (c) => {
    const body = ApprovalDecisionRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("VALIDATION_ERROR", "请求体不合法"), 400);
    const id = c.req.param("id");
    const { session } = await deps.registry.detail(id).catch(() => ({ session: null }));
    deps.approvals.submit(id, c.req.param("aid"), body.data.decision, session?.cwd ?? session?.title ?? id);
    return c.json({ ok: true });
  });

  api.get(API.fs, async (c) => {
    const res = await deps.fs.list(c.req.query("path") ?? "");
    return c.json(res);
  });

  api.get(API.audit, (c) => {
    const cursor = c.req.query("cursor") ? Number(c.req.query("cursor")) : null;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    return c.json(deps.audit.list(cursor, limit));
  });

  api.onError((e, c) => errorToResponse(c, e));

  return api;
}
