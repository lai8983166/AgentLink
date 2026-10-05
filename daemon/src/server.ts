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
import { FsService } from "./domain/fs";
import { DAEMON_VERSION } from "./server-version";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

/** 装配完整 daemon 应用（REST + WS + 静态托管） */
export interface DaemonApp {
  app: Hono;
  registry: SessionRegistry;
  approvals: ApprovalService;
  audit: AuditStore;
  bridge: CodexBridge;
  token: string;
}

export function createApp(opts: {
  token: string;
  allowedRoots: string[];
  bridge: CodexBridge;
  webDist?: string;
  auditPath?: string;
}): DaemonApp {
  const app = new Hono();

  // 健康检查：无需认证
  app.get(API.health, (c) => c.json({ ok: true, daemon: "agentlink", version: DAEMON_VERSION }));

  // 领域装配
  const bus = new SessionEventBus();
  const audit = new AuditStore(opts.auditPath);
  const approvals = new ApprovalService(opts.bridge, bus, audit);
  const fs = new FsService(opts.allowedRoots);
  const registry = new SessionRegistry(opts.bridge, bus, approvals, fs);

  // REST
  app.route("/", createApiRouter({ token: opts.token, registry, approvals, audit, fs }));

  // WS：查询参数认证（浏览器 WS 不能带 header）
  app.get(
    API.ws,
    upgradeWebSocket((c) => {
      const token = c.req.query("token");
      if (token !== opts.token) {
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

  return { app, registry, approvals, audit, bridge: opts.bridge, token: opts.token };
}

/** serveStatic 的 root 相对于进程 CWD，这里换成相对 import 路径的 posix 形式 */
function relativeRoot(webDist: string): string {
  const cwd = process.cwd().replace(/\\/g, "/");
  const d = webDist.replace(/\\/g, "/");
  if (d.startsWith(cwd)) return `./${d.slice(cwd.length + 1)}`;
  return d;
}
