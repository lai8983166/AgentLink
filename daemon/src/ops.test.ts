import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig, saveConfig } from "./config";
import { NtfyGateway } from "./notify/ntfy";
import { CodexBridge } from "./codex/bridge";
import { FakeCodexServer } from "./testing/fake-codex";
import { createApp } from "./server";

let homeBackup: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "agentlink-cfg-"));
  homeBackup = process.env.USERPROFILE;
  process.env.USERPROFILE = tmpHome;
});
afterEach(() => {
  if (homeBackup) process.env.USERPROFILE = homeBackup;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ============ 6.1 配置与 token ============ */

describe("config.toml", () => {
  test("首次加载生成 token 并落盘；再次加载保持一致", () => {
    const c1 = loadConfig({ env: {} });
    expect(c1.token).toMatch(/^[0-9a-f]{32}$/);
    expect(existsSync(configPath())).toBe(true);
    const c2 = loadConfig({ env: {} });
    expect(c2.token).toBe(c1.token);
  });

  test("写入白名单根后可读回", () => {
    const c = loadConfig({ env: {} });
    c.allowedRoots = ["F:/project", "D:/work"];
    saveConfig(c);
    const c2 = loadConfig({ env: {} });
    expect(c2.allowedRoots).toEqual(["F:/project", "D:/work"]);
  });

  test("ntfy clickBase 往返", () => {
    const c = loadConfig({ env: {} });
    c.ntfy = { enabled: true, url: "https://n.example.com", topicPrefix: "al", clickBase: "https://a.example.com" };
    saveConfig(c);
    const c2 = loadConfig({ env: {} });
    expect(c2.ntfy).toEqual(c.ntfy);
  });

  test("环境变量覆盖 port/token", () => {
    const c = loadConfig({ env: { AGENTLINK_PORT: "9999", AGENTLINK_TOKEN: "abc" } });
    expect(c.port).toBe(9999);
    expect(c.token).toBe("abc");
  });
});

describe("token 轮换端点", () => {
  test("旧 token 请求被拒；轮换后旧 token 401、新 token 可用", async () => {
    const fake = new FakeCodexServer();
    const bridge = new CodexBridge(fake);
    await bridge.start();
    const { app, registry } = createApp({
      token: "old-token",
      allowedRoots: [tmpHome],
      bridge,
      auditPath: join(tmpHome, "a.db"),
      desktop: false,
    });
    await registry.start();

    const rot = await app.request("/api/v1/admin/token/rotate", {
      method: "POST",
      headers: { Authorization: "Bearer old-token" },
    });
    expect(rot.status).toBe(200);
    const newToken = ((await rot.json()) as { token: string }).token;
    expect(newToken).not.toBe("old-token");

    const withOld = await app.request("/api/v1/sessions", {
      headers: { Authorization: "Bearer old-token" },
    });
    expect(withOld.status).toBe(401);

    const withNew = await app.request("/api/v1/sessions", {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(withNew.status).toBe(200);
  });

  test("未认证轮换请求 401", async () => {
    const fake = new FakeCodexServer();
    const bridge = new CodexBridge(fake);
    await bridge.start();
    const { app } = createApp({
      token: "t",
      allowedRoots: [tmpHome],
      bridge,
      auditPath: join(tmpHome, "b.db"),
      desktop: false,
    });
    const res = await app.request("/api/v1/admin/token/rotate", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

/* ============ 6.2 ntfy ============ */

describe("NtfyGateway", () => {
  function withMockFetch(fn: () => Promise<void> | void, captures: Array<{ url: string; body: any }>) {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      captures.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
      return new Response("{}");
    }) as unknown as typeof fetch;
    return (async () => {
      try {
        await fn();
      } finally {
        globalThis.fetch = orig;
      }
    })();
  }

  test("审批推送：同一请求只推一次；带深链与最高优先级", async () => {
    const captures: Array<{ url: string; body: any }> = [];
    const g = new NtfyGateway({
      enabled: true,
      url: "https://n.example.com",
      topicPrefix: "al",
      clickBase: "https://a.example.com",
    });
    const a = {
      rpcId: 1,
      sessionId: "s1",
      approvalId: "ap1",
      kind: "command" as const,
      command: "npm install",
      cwd: "F:/x/webapp",
      reason: null,
      availableDecisions: ["accept"],
      createdAt: Date.now(),
      expired: false,
    };
    await withMockFetch(() => {
      g.approvalRequest(a);
      g.approvalRequest(a); // 重复
    }, captures);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe("https://n.example.com/al-approval");
    expect(captures[0]?.body).toMatchObject({
      priority: 5,
      click: "https://a.example.com/s1?approval=ap1",
    });
  });

  test("完成/出错事件推送", async () => {
    const captures: Array<{ url: string; body: any }> = [];
    const g = new NtfyGateway({
      enabled: true,
      url: "https://n.example.com",
      topicPrefix: "al",
      clickBase: "",
    });
    await withMockFetch(() => {
      g.onEvent({ type: "session.status", sessionId: "s", seq: 1, at: 1, status: "done", activity: null });
      g.onEvent({ type: "session.status", sessionId: "s", seq: 2, at: 1, status: "error", activity: "崩了" });
    }, captures);
    expect(captures.map((c) => c.body.title)).toEqual(["✅ 任务完成", "🔴 任务出错"]);
    expect(captures[0]?.url).toContain("/al-task");
  });

  test("通道故障隔离：fetch 抛错不向上传播", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const g = new NtfyGateway({ enabled: true, url: "https://x", topicPrefix: "al", clickBase: "" });
    let threw = false;
    try {
      g.approvalRequest({
        rpcId: 1,
        sessionId: "s",
        approvalId: "a",
        kind: "command",
        command: "x",
        cwd: "c",
        reason: null,
        availableDecisions: [],
        createdAt: 1,
        expired: false,
      });
    } catch {
      threw = true;
    }
    globalThis.fetch = orig;
    expect(threw).toBe(false);
  });

  test("未启用时零推送", async () => {
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response();
    }) as unknown as typeof fetch;
    const g = new NtfyGateway({ enabled: false, url: "https://x", topicPrefix: "al", clickBase: "" });
    g.approvalRequest({
      rpcId: 1,
      sessionId: "s",
      approvalId: "a",
      kind: "command",
      command: "x",
      cwd: "c",
      reason: null,
      availableDecisions: [],
      createdAt: 1,
      expired: false,
    });
    globalThis.fetch = orig;
    expect(calls).toBe(0);
  });
});
