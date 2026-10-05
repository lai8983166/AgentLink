import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@agentlink/shared";
import { CodexBridge } from "../codex/bridge";
import { FakeCodexServer } from "../testing/fake-codex";
import { createApp } from "../server";
import { SessionEventBus } from "../events/bus";
import { WsConnectionHandler } from "./ws-handler";

const TOKEN = "test-token-123";

let tmpRoot: string;
let webDist: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "agentlink-api-"));
  webDist = join(tmpRoot, "webdist");
  mkdirSync(webDist);
  writeFileSync(join(webDist, "index.html"), "<html>agentlink pwa</html>");
  writeFileSync(join(webDist, "app.js"), "console.log(1)");
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 占用 */
  }
});

async function setup() {
  const fake = new FakeCodexServer();
  const bridge = new CodexBridge(fake);
  await bridge.start();
  const { app, registry } = createApp({
    token: TOKEN,
    allowedRoots: [tmpRoot],
    bridge,
    webDist,
    auditPath: join(tmpRoot, "audit.db"),
  });
  await registry.start();
  const authed = { Authorization: `Bearer ${TOKEN}` } as Record<string, string>;
  return { fake, app, registry, authed };
}

/* ============ 5.1 REST：认证 + 错误 envelope ============ */

describe("REST API", () => {
  test("health 免认证", async () => {
    const { app } = await setup();
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("无 token → 401 envelope，不泄露业务数据", async () => {
    const { app } = await setup();
    const res = await app.request("/api/v1/sessions");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("错误 token → 401", async () => {
    const { app } = await setup();
    const res = await app.request("/api/v1/sessions", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  test("会话列表（含 rollout 旧会话）", async () => {
    const { app, authed } = await setup();
    const res = await app.request("/api/v1/sessions", { headers: authed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; status: string }> };
    expect(body.sessions.some((s) => s.id === "old1" && s.status === "idle")).toBe(true);
  });

  test("创建会话：合法路径 201；白名单外 409 PATH_NOT_ALLOWED", async () => {
    const { app, authed } = await setup();
    const ok = await app.request("/api/v1/sessions", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: tmpRoot, approvalPolicy: "untrusted", prompt: "测试任务" }),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { id: string }).id).toBe("t1");

    const bad = await app.request("/api/v1/sessions", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: "C:/Windows", approvalPolicy: "never", prompt: "x" }),
    });
    expect(bad.status).toBe(409);
    expect((((await bad.json()) as { error: { code: string } }).error.code)).toBe("PATH_NOT_ALLOWED");
  });

  test("创建请求体缺失字段 → 400 VALIDATION_ERROR", async () => {
    const { app, authed } = await setup();
    const res = await app.request("/api/v1/sessions", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: tmpRoot }),
    });
    expect(res.status).toBe(400);
  });

  test("会话详情含 rollout 历史", async () => {
    const { app, authed } = await setup();
    const res = await app.request("/api/v1/sessions/old1", { headers: authed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { history: Array<{ type: string }> };
      latestSeq: number;
    };
    expect(body.session.history.map((h) => h.type)).toEqual(["userMessage", "agentMessage", "toolCall"]);
    expect(typeof body.latestSeq).toBe("number");
  });

  test("resume 占用冲突 → 409 SESSION_BUSY", async () => {
    const { app, authed } = await setup();
    const res = await app.request("/api/v1/sessions/busy/resume", {
      method: "POST",
      headers: authed,
    });
    expect(res.status).toBe(409);
    expect((((await res.json()) as { error: { code: string } }).error.code)).toBe("SESSION_BUSY");
  });

  test("审批提交 → 200 且落审计；过期 → 409 APPROVAL_EXPIRED", async () => {
    const { fake, app, authed } = await setup();
    fake.send({
      jsonrpc: "2.0",
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: "t1",
        itemId: "exec-1",
        command: "pnpm install",
        cwd: tmpRoot,
        availableDecisions: ["accept", "cancel"],
      },
    });
    const ok = await app.request("/api/v1/sessions/t1/approvals/exec-1", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(ok.status).toBe(200);

    const audit = (await (
      await app.request("/api/v1/audit", { headers: authed })
    ).json()) as { entries: Array<{ command: string | null; decision: string }> };
    expect(audit.entries[0]).toMatchObject({ command: "pnpm install", decision: "accept" });

    // 过期场景
    fake.send({
      jsonrpc: "2.0",
      id: 10,
      method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: "t1", itemId: "exec-2", command: "rm x", cwd: tmpRoot, availableDecisions: ["accept"] },
    });
    // 轮次结束 → 作废
    fake.notify("turn/completed", { threadId: "t1", turn: { id: "x", error: null } });
    const expired = await app.request("/api/v1/sessions/t1/approvals/exec-2", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(expired.status).toBe(409);
    expect((((await expired.json()) as { error: { code: string } }).error.code)).toBe("APPROVAL_EXPIRED");
  });

  test("PATCH 策略切换", async () => {
    const { app, registry, authed } = await setup();
    // 先让 t1 进 live
    await registry.resume("t1").catch(() => {});
    const res = await app.request("/api/v1/sessions/t1", {
      method: "PATCH",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "never" }),
    });
    expect(res.status).toBe(200);
    const list = (await (
      await app.request("/api/v1/sessions", { headers: authed })
    ).json()) as { sessions: Array<{ id: string; approvalPolicy: string }> };
    expect(list.sessions.find((s) => s.id === "t1")?.approvalPolicy).toBe("never");
  });

  test("fs：白名单内列出；越界 409", async () => {
    const { app, authed } = await setup();
    const ok = await app.request(`/api/v1/fs?path=${encodeURIComponent(tmpRoot)}`, {
      headers: authed,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.some((e) => e.name === "webdist")).toBe(true);

    const bad = await app.request(`/api/v1/fs?path=${encodeURIComponent("C:/Windows")}`, {
      headers: authed,
    });
    expect(bad.status).toBe(409);
  });
});

/* ============ 5.2 WS 处理器 ============ */

describe("WsConnectionHandler", () => {
  test("subscribe → subscribed + 补发；实时事件推送；close 退订", () => {
    const bus = new SessionEventBus();
    const sent: ServerMessage[] = [];
    const handler = new WsConnectionHandler(bus, (m) => sent.push(m));

    // 先产生 3 条历史
    bus.publish("s1", { type: "error", message: "e1" });
    bus.publish("s1", { type: "error", message: "e2" });
    bus.publish("s1", { type: "error", message: "e3" });

    handler.handle({ type: "subscribe", sessionId: "s1", lastSeq: 1 });
    // subscribed + 补发 e2 e3
    expect(sent.filter((m) => m.type === "subscribed")).toHaveLength(1);
    const events = sent.filter((m) => m.type === "event") as Array<{ event: { seq: number } }>;
    expect(events.map((e) => e.event.seq)).toEqual([2, 3]);

    // 实时
    bus.publish("s1", { type: "error", message: "e4" });
    expect(sent.filter((m) => m.type === "event")).toHaveLength(3);

    // close 后不再收
    handler.close();
    bus.publish("s1", { type: "error", message: "e5" });
    expect(sent.filter((m) => m.type === "event")).toHaveLength(3);
  });

  test("超窗 → snapshot.required", () => {
    const bus = new SessionEventBus();
    const sent: ServerMessage[] = [];
    const handler = new WsConnectionHandler(bus, (m) => sent.push(m));
    for (let i = 0; i < 600; i++) bus.publish("s1", { type: "error", message: "x" });
    handler.handle({ type: "subscribe", sessionId: "s1", lastSeq: 5 });
    expect(sent.some((m) => m.type === "snapshot.required")).toBe(true);
  });

  test("ping/pong 与坏消息", () => {
    const bus = new SessionEventBus();
    const sent: ServerMessage[] = [];
    const handler = new WsConnectionHandler(bus, (m) => sent.push(m));
    handler.handle({ type: "ping" });
    expect(sent.some((m) => m.type === "pong")).toBe(true);
    handler.handle({ type: "hacker" });
    expect(sent.some((m) => m.type === "error")).toBe(true);
  });

  test("列表订阅", () => {
    const bus = new SessionEventBus();
    const sent: ServerMessage[] = [];
    const handler = new WsConnectionHandler(bus, (m) => sent.push(m));
    handler.handle({ type: "subscribeList" });
    bus.publishList({
      type: "session.created",
      summary: {
        id: "x",
        title: "t",
        cwd: "c",
        agent: "codex",
        status: "running",
        activeElsewhere: false,
        preview: "p",
        lastActivityAt: 1,
        approvalPolicy: "on-request",
        pendingApprovals: 0,
      },
    });
    expect(sent.some((m) => m.type === "listEvent")).toBe(true);
  });
});

/* ============ 5.3 静态托管 + SPA fallback ============ */

describe("静态托管", () => {
  test("/ 返回 index；深链路由 fallback 到 index；静态文件直出", async () => {
    const { app } = await setup();
    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("agentlink pwa");

    const deep = await app.request("/some-session-id?approval=x");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("agentlink pwa");

    const asset = await app.request("/app.js");
    expect(asset.status).toBe(200);
  });
});
