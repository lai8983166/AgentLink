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
import { LimitsRefresh } from "./domain/limits-refresh";
import { FsService } from "./domain/fs";
import { DesktopSessionManager } from "./ipc/desktop-manager";
import { NtfyGateway, type NtfyConfig } from "./notify/ntfy";
import { DAEMON_VERSION } from "./server-version";
import { randomUUID } from "node:crypto";
import { ControlStore } from "./domain/control-store";
import { configDir } from "./config";
import type { ResumeSettings } from "./codex/resume-settings";
import { PushStore } from "./notify/push-store";
import { WebPushService, type PushSender } from "./notify/web-push";
import { createPushRouter } from "./routes/push";
import { createNativePushRouter } from "./routes/native-push";
import { cors } from "hono/cors";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

/** 装配完整 daemon 应用（REST + WS + 静态托管 + ntfy 旁路） */
export interface DaemonApp {
  app: Hono;
  registry: SessionRegistry;
  approvals: ApprovalService;
  audit: AuditStore;
  bridge: CodexBridge;
  auth: { token: string };
  controls: ControlStore;
  limitsRefresh: LimitsRefresh;
  push: WebPushService;
  desktop?: DesktopSessionManager;
}

export function createApp(opts: {
  token: string;
  allowedRoots: string[];
  bridge: CodexBridge;
  webDist?: string;
  auditPath?: string;
  /** 自动化测试禁用真实桌面管道，保证不触碰用户会话。 */
  desktop?: false;
  assertNoWriter?: (id: string) => Promise<void>;
  resumeSettings?: (id: string) => Promise<ResumeSettings>;
  desktopFactory?: (bus: SessionEventBus, approvals: ApprovalService, controls: ControlStore) => DesktopSessionManager;
  ntfy?: NtfyConfig;
  /** 测试传输注入，禁止自动化向真实手机或外部推送服务发消息。 */
  pushSender?: PushSender;
  /** 轮换后持久化回调（写配置文件） */
  onTokenRotate?: (newToken: string) => void;
}): DaemonApp {
  const app = new Hono();
  const auth = { token: opts.token };
  // APK 内置页面的固定本地来源；API 仍必须通过 Bearer 配对认证。
  app.use("/api/*", cors({ origin: "https://localhost", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));

  // 健康检查：无需认证
  app.get(API.health, (c) => c.json({ ok: true, daemon: "agentlink", version: DAEMON_VERSION }));

  // 领域装配
  const bus = new SessionEventBus();
  const audit = new AuditStore(opts.auditPath);
  const approvals = new ApprovalService(opts.bridge, bus, audit);
  const fs = new FsService(opts.allowedRoots);
  const controls = new ControlStore(opts.auditPath ? `${opts.auditPath}.controls` : join(configDir(), "controls.db"));
  const registry = new SessionRegistry(opts.bridge, bus, approvals, fs, controls, opts.assertNoWriter, opts.resumeSettings);
  const push = new WebPushService(new PushStore(opts.auditPath ? `${opts.auditPath}.push` : join(configDir(), "push.db")), opts.pushSender);
  bus.tap((e) => push.onEvent(e));

  // 账户限额（app-server 通知 + 桌面会话 rollout 尾读）：状态 pill / 用尽告警
  const limits = new LimitsMonitor();
  limits.onChange = (l) => bus.publishList({ type: "account.limits", limits: l });
  registry.setLimitsMonitor(limits);
  const limitsRefresh = new LimitsRefresh(limits, opts.bridge);
  opts.bridge.onFact((fact) => {
    if (fact.kind === "accountChanged") { limitsRefresh.invalidate(); void limitsRefresh.refresh(true); }
  });
  opts.bridge.onRestart(() => limitsRefresh.invalidate());

  // 桌面 IPC follower（任务 3.1）：观察/接管桌面持有会话
  const desktop = opts.desktop === false ? undefined : opts.desktopFactory?.(bus, approvals, controls) ?? new DesktopSessionManager(bus, approvals, {
    controls,
    log: (...a: unknown[]) => console.log("[desktop]", ...a),
  });
  if (desktop) {
    desktop.limitsMonitor = limits;
    approvals.desktopDelegate = {
      decide: (sessionId, requestId, decision, kind) => desktop.decide(sessionId, requestId, decision, kind),
    };
    registry.setDesktopManager(desktop);
  }

  // REST
  app.route(
    "/",
    createApiRouter({ token: opts.token, registry, approvals, audit, fs, auth, desktop, limits, limitsRefresh,
      connectionHealth: () => ({ appServer: opts.bridge.ready ? "ready" : "disconnected", desktop: desktop?.connectionHealth().state ?? "disabled", lastDesktopSyncAt: desktop?.connectionHealth().lastSyncAt ?? null }) }),
  );

  app.route("/", createPushRouter(push, auth));
  app.route("/", createNativePushRouter(push, auth));
  // 安装包不含配对信息；同一 HTTPS 入口提供自用 APK 下载。
  app.get("/downloads/agentlink.apk", () => {
    const apk = join(import.meta.dir, "../../mobile/release/AgentLink.apk");
    if (!existsSync(apk)) return new Response("Android APK has not been built", { status: 404 });
    return new Response(Bun.file(apk), { headers: { "Content-Type": "application/vnd.android.package-archive", "Content-Disposition": "attachment; filename=AgentLink.apk", "Cache-Control": "no-store" } });
  });

  // token 轮换（remote-access spec：轮换后旧 token 立即失效）
  app.post("/api/v1/admin/token/rotate", async (c) => {
    if (c.req.header("Authorization") !== `Bearer ${auth.token}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "认证失败" } }, 401);
    }
    auth.token = randomUUID().replace(/-/g, "");
    push.store.revokeAll();
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

  return { app, registry, approvals, audit, controls, desktop, bridge: opts.bridge, auth, limitsRefresh, push };
}

/** serveStatic 的 root 相对于进程 CWD，这里换成相对 import 路径的 posix 形式 */
function relativeRoot(webDist: string): string {
  const cwd = process.cwd().replace(/\\/g, "/");
  const d = webDist.replace(/\\/g, "/");
  if (d.startsWith(cwd)) return `./${d.slice(cwd.length + 1)}`;
  return d;
}
