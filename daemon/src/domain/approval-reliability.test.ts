import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { ApprovalService } from "./approvals";
import { AuditStore } from "./audit";
import { CodexBridge } from "../codex/bridge";
import { FakeCodexServer } from "../testing/fake-codex";
import { SessionEventBus } from "../events/bus";
import { createApiRouter } from "../routes/api";

let folder: string;
let audit: AuditStore;
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), "agentlink-approval-")); audit = new AuditStore(join(folder, "audit.db")); });
afterEach(() => { audit.close(); rmSync(folder, { recursive: true, force: true }); });

function setup() {
  const bridge = new CodexBridge(new FakeCodexServer());
  const bus = new SessionEventBus();
  const approvals = new ApprovalService(bridge, bus, audit);
  const resolved: unknown[] = [];
  bus.tap((e) => { if (e.type === "approval.resolved") resolved.push(e); });
  const register = (sessionId = "s1", kind: "command" | "fileChange" = "command") => approvals.registerDesktop({
    sessionId, requestId: "2", kind, command: "echo test", cwd: "F:/test", reason: null, availableDecisions: ["accept", "decline"],
  });
  return { approvals, resolved, register };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

describe("桌面审批必须以回执确认", () => {
  test("REST 等待回执；收到之前保留待审批，不能写成功审计或推送已批准", async () => {
    const { approvals, resolved, register } = setup();
    register();
    const ack = deferred();
    approvals.desktopDelegate = { decide: () => ack.promise };
    const router = createApiRouter({ token: "test", approvals, audit,
      registry: { detail: async () => ({ session: { cwd: "F:/test" } }) } as never, fs: {} as never });
    const app = new Hono().route("/", router);
    let completed = false;
    const request = Promise.resolve(app.request("/api/v1/sessions/s1/approvals/2", {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ decision: "accept" }),
    })).then((r) => { completed = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(completed).toBe(false);
    expect(approvals.countPending("s1")).toBe(1);
    expect(resolved).toHaveLength(0);
    expect(audit.list(null).entries).toHaveLength(0);
    approvals.resolveDesktop("s1", "2"); // 桌面先推请求消失，回执尚未返回
    expect(resolved).toHaveLength(0);
    ack.resolve();
    expect((await request).status).toBe(200);
    expect(approvals.countPending("s1")).toBe(0);
    expect(resolved).toHaveLength(1);
    expect(audit.list(null).entries).toHaveLength(1);
  });

  test("桌面拒绝或断线后保留卡片，同一决定可以重试", async () => {
    const { approvals, resolved, register } = setup();
    register();
    let attempts = 0;
    approvals.desktopDelegate = { decide: async () => { if (++attempts === 1) throw new Error("ipc closed"); } };
    await expect(approvals.submit("s1", "2", "accept", "test")).rejects.toThrow("ipc closed");
    expect(approvals.countPending("s1")).toBe(1);
    expect(resolved).toHaveLength(0);
    expect(audit.list(null).entries).toHaveLength(0);
    await approvals.submit("s1", "2", "accept", "test");
    expect(attempts).toBe(2);
    expect(resolved).toHaveLength(1);
  });

  test("并发同决定共享回执，只委托一次；冲突决定拒绝", async () => {
    const { approvals, register } = setup();
    register();
    const ack = deferred();
    let calls = 0;
    approvals.desktopDelegate = { decide: () => { calls++; return ack.promise; } };
    const first = approvals.submit("s1", "2", "accept", "test");
    const second = approvals.submit("s1", "2", "accept", "test");
    expect(second).toBe(first);
    expect(() => approvals.submit("s1", "2", "decline", "test")).toThrow("正在提交");
    ack.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    await approvals.submit("s1", "2", "accept", "test");
    expect(calls).toBe(1);
    expect(audit.list(null).entries).toHaveLength(1);
  });

  test("不同会话相同数字 ID 各自提交；文件审批保留种类", async () => {
    const { approvals, register } = setup();
    const calls: unknown[] = [];
    approvals.desktopDelegate = { decide: async (...args) => { calls.push(args); } };
    register("s1");
    await approvals.submit("s1", "2", "accept", "test");
    register("s2", "fileChange");
    expect(approvals.countPending("s2")).toBe(1);
    await approvals.submit("s2", "2", "decline", "test");
    expect(calls).toEqual([["s1", "2", "accept", "command"], ["s2", "2", "decline", "fileChange"]]);
    expect(audit.list(null).entries).toHaveLength(2);
  });

  test("轮次已结束时迟到的成功回执不能再次宣告批准", async () => {
    const { approvals, resolved, register } = setup();
    register();
    const ack = deferred();
    approvals.desktopDelegate = { decide: () => ack.promise };
    const result = approvals.submit("s1", "2", "accept", "test");
    approvals.expireSession("s1");
    ack.resolve();
    await expect(result).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(resolved).toEqual([expect.objectContaining({ decision: "expired" })]);
    expect(audit.list(null).entries).toHaveLength(0);
  });

  test("没有委托通道不能返回审批成功", () => {
    const { approvals, register } = setup();
    register();
    expect(() => approvals.submit("s1", "2", "accept", "test")).toThrow("未连接");
    expect(approvals.countPending("s1")).toBe(1);
  });
});
