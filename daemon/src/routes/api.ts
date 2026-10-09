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
  /** 可变 token 持有者：轮换后立即生效 */
  auth?: { token: string };
  registry: SessionRegistry;
  approvals: ApprovalService;
  audit: AuditStore;
  fs: FsService;
  /** 账户限额（状态 pill 数据源；缺省时 rateLimits 为 null） */
  limits?: { snapshot(): { primary: { resetsAt: number }; secondary: unknown } | null };
  connectionHealth?: () => { appServer: string; desktop: string; lastDesktopSyncAt: number | null };
  desktop?: {
    observe(id: string, mode?: "observe" | "takeover"): Promise<void>;
    takeover(id: string): Promise<void>;
    has(id: string): boolean;
    stop(id: string): void;
  };
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function authMiddleware(tokenRef: { token: string }): MiddlewareHandler {
  return async (c, next) => {
    // WS 端点走自己的查询参数认证（浏览器 WS 不能带 header）
    if (c.req.path === API.ws) {
      await next();
      return;
    }
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${tokenRef.token}`) {
      return c.json(errorBody("UNAUTHORIZED", "缺失或无效 token"), 401);
    }
    await next();
  };
}

/** DaemonError/IPC 错误 → envelope；zod → VALIDATION_ERROR；其余 → INTERNAL */
export function errorToResponse(c: Context, e: unknown) {
  if (e instanceof DaemonError) {
    const status = e.code === "UNAUTHORIZED" ? 401 : e.code.startsWith("SESSION_NOT") || e.code === "APPROVAL_NOT_FOUND" ? 404 : e.code === "VALIDATION_ERROR" ? 400 : e.code === "SESSION_BUSY" || e.code === "APPROVAL_EXPIRED" || e.code === "PATH_NOT_ALLOWED" || e.code === "APPROVAL_ALREADY_DECIDED" ? 409 : 500;
    return c.json(errorBody(e.code, e.message), status as 400 | 401 | 404 | 409 | 500);
  }
  // IPC 层错误（Error with IPC_* 前缀）
  if (e instanceof Error && /^IPC_/.test(e.message)) {
    const code = e.message.split(":")[0] ?? "IPC_ERROR";
    return c.json(errorBody(code, e.message), code === "IPC_OWNER_NOT_FOUND" ? 404 : 502);
  }
  console.error("[api] internal error:", e);
  return c.json(errorBody("INTERNAL", "内部错误"), 500);
}

export function createApiRouter(deps: ApiDeps): Hono {
  const api = new Hono();
  // 认证只作用于 /api/v1/*，不影响静态资源与 SPA fallback
  api.use("/api/v1/*", authMiddleware(deps.auth ?? { token: deps.token }));

  api.get(API.status, (c) =>
    c.json({
      daemonVersion: DAEMON_VERSION,
      mode: c.req.header("Host")?.startsWith("127.0.0.1") || c.req.header("Host")?.startsWith("localhost")
        ? "local"
        : "lan",
      latencyMs: null,
      rateLimits: deps.limits?.snapshot() ?? null,
      pendingApprovals: 0,
      connections: deps.connectionHealth?.(),
    }),
  );

  api.get(API.sessions, async (c) => c.json({ sessions: await deps.registry.list() }));
  api.get("/api/v1/admin/restart-readiness", (c) => c.json(deps.registry.restartReadiness()));
  api.post("/api/v1/admin/prepare-restart", (c) => {
    const readiness = deps.registry.prepareRestart();
    return c.json(readiness, readiness.safe ? 200 : 409);
  });
  api.post("/api/v1/admin/cancel-restart", (c) => { deps.registry.cancelRestart(); return c.json({ ok: true }); });

  api.post(API.sessions, async (c) => {
    const body = CreateSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("VALIDATION_ERROR", "请求体不合法"), 400);
    const id = await deps.registry.create(body.data);
    return c.json({ id }, 201);
  });

  api.get("/api/v1/sessions/:id", async (c) => {
    return c.json(await deps.registry.detail(c.req.param("id")));
  });

  api.post("/api/v1/sessions/:id/resume", async (c) => {
    const session = await deps.registry.resume(c.req.param("id"));
    return c.json({ session });
  });

  api.post("/api/v1/sessions/:id/message", async (c) => {
    const body = SendMessageRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("VALIDATION_ERROR", "请求体不合法"), 400);
    const receipt = await deps.registry.sendMessage(c.req.param("id"), body.data.text, body.data.clientMessageId);
    return c.json({ ok: true, receipt });
  });

  api.get("/api/v1/sessions/:id/messages/:messageId", (c) =>
    c.json({ receipt: deps.registry.messageReceipt(c.req.param("id"), c.req.param("messageId")) }));

  api.post("/api/v1/sessions/:id/interrupt", async (c) => {
    await deps.registry.interrupt(c.req.param("id"));
    return c.json({ ok: true });
  });

  // 桌面会话：观察 / 接管 / 停止观察（任务 3.2）
  api.post("/api/v1/sessions/:id/observe", async (c) => {
    const mode = (await c.req.json().catch(() => ({}))) as { mode?: string };
    await deps.registry.observe(c.req.param("id"), mode.mode === "takeover" ? "takeover" : "observe");
    return c.json({ ok: true, mode: mode.mode === "takeover" ? "takeover" : "observe" });
  });

  api.post("/api/v1/sessions/:id/takeover", async (c) => {
    await deps.registry.takeover(c.req.param("id"));
    return c.json({ ok: true, mode: "takeover" });
  });

  api.post("/api/v1/sessions/:id/unobserve", (c) => {
    deps.desktop?.stop(c.req.param("id"));
    return c.json({ ok: true });
  });

  // 兜底接力（任务 3.2）：fork 出归本方管理的新会话
  api.post("/api/v1/sessions/:id/fork", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { approvalPolicy?: string };
    const id = await deps.registry.fork(
      c.req.param("id"),
      (body.approvalPolicy as "untrusted" | "on-request" | "never" | undefined) ?? undefined,
    );
    return c.json({ id }, 201);
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
    await deps.approvals.submit(id, c.req.param("aid"), body.data.decision, session?.cwd ?? session?.title ?? id);
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
