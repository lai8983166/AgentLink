import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { serveStatic } from "hono/bun";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { API } from "@agentlink/shared";
import { createApiRouter } from "./routes/api";
import { WsConnectionHandler } from "./routes/ws-handler";
import { CodexBridge } from "./codex/bridge";
import { SessionEventBus } from "./events/bus";
import { AuditStore } from "./domain/audit";
import { ApprovalService } from "./domain/approvals";
import { SessionRegistry } from "./domain/sessions";
import { LimitsMonitor } from "./domain/limits";
import { FsService } from "./domain/fs";
import { DesktopSessionManager } from "./ipc/desktop-manager";
import { NtfyGateway, type NtfyConfig } from "./notify/ntfy";
import { DAEMON_VERSION } from "./server-version";
import { randomUUID } from "node:crypto";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

/** 装配完整 daemon 应用（REST + WS + 静态托管 + ntfy 旁路） */
export interface DaemonApp {
  app: Hono;
  registry: SessionRegistry;
  approvals: ApprovalService;
  audit: AuditStore;
  bridge: CodexBridge;
  auth: { token: string };
}

export function createApp(opts: {
  token: string;
  allowedRoots: string[];
  bridge: CodexBridge;
  webDist?: string;
  auditPath?: string;
  ntfy?: NtfyConfig;
  /** 轮换后持久化回调（写配置文件） */
  onTokenRotate?: (newToken: string) => void;
}): DaemonApp {
  const app = new Hono();
  const auth = { token: opts.token };

  // 健康检查：无需认证
  app.get(API.health, (c) => c.json({ ok: true, daemon: "agentlink", version: DAEMON_VERSION }));

  // 领域装配
  const bus = new SessionEventBus();
  const audit = new AuditStore(opts.auditPath);
  const approvals = new ApprovalService(opts.bridge, bus, audit);
  const fs = new FsService(opts.allowedRoots);
  const registry = new SessionRegistry(opts.bridge, bus, approvals, fs);

  // 账户限额（app-server 通知 + 桌面会话 rollout 尾读）：状态 pill / 用尽告警
  const limits = new LimitsMonitor();
  limits.onChange = (l) => bus.publishList({ type: "account.limits", limits: l });
  registry.setLimitsMonitor(limits);

  // 桌面 IPC follower（任务 3.1）：观察/接管桌面持有会话
  const desktop = new DesktopSessionManager(bus, approvals, {
    log: (...a: unknown[]) => console.log("[desktop]", ...a),
  });
  desktop.limitsMonitor = limits;
  approvals.desktopDelegate = {
    decide: (sessionId, requestId, decision) => desktop.decide(sessionId, requestId, decision),
  };
  registry.setDesktopManager(desktop);

  // REST
  app.route(
    "/",
    createApiRouter({ token: opts.token, registry, approvals, audit, fs, auth, desktop, limits }),
  );

  // token 轮换（remote-access spec：轮换后旧 token 立即失效）
  app.post("/api/v1/admin/token/rotate", async (c) => {
    if (c.req.header("Authorization") !== `Bearer ${auth.token}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "认证失败" } }, 401);
    }
    auth.token = randomUUID().replace(/-/g, "");
    opts.onTokenRotate?.(auth.token);
    return c.json({ token: auth.token });
  });

  // ntfy 旁路（任务 6.2）：审批请求 + 完成/出错；通道故障不影响主链路
  const ntfy = new NtfyGateway(
    opts.ntfy ?? { enabled: false, url: "", topicPrefix: "agentlink", clickBase: "" },
  );
  approvals.onRequest((a) => ntfy.approvalRequest(a));
  limits.onExhausted = (window, w) => ntfy.quotaExhausted(window, w.resetsAt);
  bus.tap((e) => {
    if ("type" in e) ntfy.onEvent(e as Parameters<typeof ntfy.onEvent>[0]);
  });

  // WS：查询参数认证（浏览器 WS 不能带 header）；轮换后旧 token 即刻失效
  app.get(
    API.ws,
    upgradeWebSocket((c) => {
      const token = c.req.query("token");
      if (token !== auth.token) {
        return {
          onOpen(evt, ws) {
            ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "认证失败" }));
            ws.close();
          },
        };
      }
      const handler = { current: null as WsConnectionHandler | null };
      return {
        onOpen(_evt, ws) {
          handler.current = new WsConnectionHandler(bus, (m) => ws.send(JSON.stringify(m)));
        },
        onMessage(evt, ws) {
          try {
            const raw = typeof evt.data === "string" ? JSON.parse(evt.data) : null;
            handler.current?.handle(raw);
          } catch {
            ws.send(JSON.stringify({ type: "error", code: "VALIDATION_ERROR", message: "非 JSON 消息" }));
          }
        },
        onClose() {
          handler.current?.close();
        },
      };
    }),
  );

  // PWA 静态托管 + SPA fallback（任务 5.3）
  const webDist = opts.webDist ?? join(import.meta.dir, "../../web/dist");
  if (existsSync(webDist)) {
    app.use("*", serveStatic({ root: relativeRoot(webDist) }));
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      const index = join(webDist, "index.html");
      if (existsSync(index)) return c.html(readFileSync(index, "utf-8"));
      return c.notFound();
    });
  }

  return { app, registry, approvals, audit, bridge: opts.bridge, auth };
}

/** serveStatic 的 root 相对于进程 CWD，这里换成相对 import 路径的 posix 形式 */
function relativeRoot(webDist: string): string {
  const cwd = process.cwd().replace(/\\/g, "/");
  const d = webDist.replace(/\\/g, "/");
  if (d.startsWith(cwd)) return `./${d.slice(cwd.length + 1)}`;
  return d;
}
