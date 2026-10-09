import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@agentlink/shared";
import { CodexBridge, DaemonError } from "../codex/bridge";
import { SessionEventBus } from "../events/bus";
import { FakeCodexServer } from "../testing/fake-codex";
import { AuditStore } from "./audit";
import { ApprovalService } from "./approvals";
import { SessionRegistry } from "./sessions";
import { FsService } from "./fs";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "agentlink-test-"));
});

/* ============ 4.1/4.2 状态机 ============ */

describe("SessionRegistry 状态机", () => {
  async function setup(assertNoWriter?: (id: string) => Promise<void>) {
    const fake = new FakeCodexServer();
    const bridge = new CodexBridge(fake);
    const bus = new SessionEventBus();
    const audit = new AuditStore(join(tmpRoot, "audit.db"));
    const approvals = new ApprovalService(bridge, bus, audit);
    const fs = new FsService([tmpRoot]);
    const reg = new SessionRegistry(bridge, bus, approvals, fs, undefined, assertNoWriter, async () => ({ sandbox: "danger-full-access", approvalPolicy: "never" }));
    await bridge.start();
    await reg.start();
    const events: SessionEvent[] = [];
    bus.subscribe("t1", null, (e) => events.push(e as SessionEvent));
    return { fake, bridge, bus, audit, approvals, reg, events };
  }

  test("waitingOnApproval → waiting_approval；审批后回 running；完成后 done 且不被 idle 覆盖", async () => {
    const { fake, events, reg } = await setup();
    fake.notify("thread/started", {
      threadId: "t1",
      thread: { id: "t1", environments: [{ cwd: tmpRoot }] },
    });
    fake.notify("thread/status/changed", { threadId: "t1", status: { type: "active", activeFlags: [] } });
    fake.notify("thread/status/changed", {
      threadId: "t1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });

    const statuses = events.filter((e) => e.type === "session.status").map((e) => (e as { status: string }).status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("waiting_approval");

    fake.notify("thread/status/changed", { threadId: "t1", status: { type: "active", activeFlags: [] } });
    fake.notify("turn/completed", { threadId: "t1", turn: { id: "x", error: null } });
    fake.notify("thread/status/changed", { threadId: "t1", status: { type: "idle" } });

    const list = await reg.list();
    const t1 = list.find((s) => s.id === "t1");
    expect(t1?.status).toBe("done"); // idle 不覆盖 done
  });

  test("turn 出错 → error", async () => {
    const { fake, reg } = await setup();
    fake.notify("thread/started", {
      threadId: "t1",
      thread: { id: "t1", environments: [{ cwd: tmpRoot }] },
    });
    fake.notify("turn/completed", { threadId: "t1", turn: { id: "x", error: { message: "boom" } } });
    const list = await reg.list();
    expect(list.find((s) => s.id === "t1")?.status).toBe("error");
  });

  test("列表：live 优先于 rollout，等待审批排最前", async () => {
    const { fake, reg } = await setup();
    fake.notify("thread/started", {
      threadId: "t1",
      thread: { id: "t1", environments: [{ cwd: tmpRoot }] },
    });
    fake.notify("thread/status/changed", {
      threadId: "t1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    const list = await reg.list();
    expect(list[0]?.id).toBe("t1"); // waiting_approval 排最前
    expect(list.find((s) => s.id === "old1")?.status).toBe("unknown"); // 未连接拥有者不能假定空闲
    // 最近有 rollout 写入 → activeElsewhere（正在电脑上使用）+ 占用方显示名
    expect(list.find((s) => s.id === "old1")?.activeElsewhere).toBe(true);
    expect(list.find((s) => s.id === "old1")?.activeVia).toBe("ChatGPT 桌面端");
    expect(list.find((s) => s.id === "old1")?.desktopManaged).toBe(true);
    expect(list.find((s) => s.id === "old1")?.lastActivityAt).toBeGreaterThan(0);
  });

  test("消息与历史：userMessage/agentMessage/工具进 history", async () => {
    const { fake, reg } = await setup();
    fake.notify("thread/started", {
      threadId: "t1",
      thread: { id: "t1", environments: [{ cwd: tmpRoot }] },
    });
    fake.notify("item/completed", {
      threadId: "t1",
      item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "修一下" }] },
    });
    fake.notify("item/completed", {
      threadId: "t1",
      item: { type: "agentMessage", id: "a1", text: "好的" },
    });
    fake.notify("item/completed", {
      threadId: "t1",
      item: {
        type: "commandExecution",
        id: "e1",
        command: "pnpm build",
        exitCode: 0,
        aggregatedOutput: "ok",
      },
    });
    const { session } = await reg.detail("t1");
    expect(session.history.map((h) => h.type)).toEqual(["userMessage", "agentMessage", "toolCall"]);
  });

  test("resume：SESSION_BUSY 映射", async () => {
    const { reg } = await setup();
    try {
      await reg.resume("busy");
      expect.unreachable();
    } catch (e) {
      expect(e instanceof DaemonError && e.code).toBe("SESSION_BUSY");
    }
  });

  test("resume：owner 存在或检测失败都不恢复；普通会话无人持有可恢复", async () => {
    const { reg, fake } = await setup(async () => { throw new DaemonError("SESSION_BUSY", "writer held"); });
    let ownerAlive: boolean | Error = true;
    reg.setDesktopManager({
      observe: async () => {},
      takeover: async () => {},
      has: () => false,
      isTakenOver: () => false,
      overlay: () => new Map(),
      sendTurn: async () => {},
      interrupt: async () => {},
      historyFor: () => null,
      ownerAlive: async () => {
        if (ownerAlive instanceof Error) throw ownerAlive;
        return ownerAlive;
      },
      onSummaryChange: () => {},
    });
    for (const state of [true, false]) {
      ownerAlive = state;
      await expect(reg.resume("old1")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    }
    ownerAlive = new Error("IPC_UNAVAILABLE");
    await expect(reg.resume("old1")).rejects.toThrow("IPC_UNAVAILABLE");
    expect(fake.written.map((s) => JSON.parse(s).method)).not.toContain("thread/resume");
    // 未知来源的会话也必须先确认 owner；检测失败不能当作无人持有。
    await expect(reg.resume("ordinary")).rejects.toThrow("IPC_UNAVAILABLE");
    expect(fake.written.map((s) => JSON.parse(s).method)).not.toContain("thread/resume");
    ownerAlive = true;
    await expect(reg.resume("ordinary")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    ownerAlive = false;
    const detail = await reg.resume("ordinary");
    expect(detail.id).toBe("ordinary");
    expect(fake.written.map((s) => JSON.parse(s).method)).toContain("thread/resume");
  });

  function desktop(ownerAlive?: () => Promise<boolean>) {
    return { observe: async () => {}, takeover: async () => {}, has: () => false, isTakenOver: () => false,
      overlay: () => new Map(), sendTurn: async () => {}, interrupt: async () => {}, historyFor: () => null,
      ownerAlive, onSummaryChange: () => {} };
  }

  test("无人持有原会话：并发恢复一次，保留 ID、历史和 Full Access，刷新不重置任务", async () => {
    const checks: string[] = [];
    const { reg, fake, bus } = await setup(async (id) => { checks.push(id); });
    reg.setDesktopManager(desktop(async () => false));
    const [a, b] = await Promise.all([reg.resume("old1"), reg.resume("old1")]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ id: "old1", controlMode: "local", desktopManaged: false, activeElsewhere: false, desktopGone: false, approvalPolicy: "never", forkedFromId: null });
    expect(a.history.map((h) => h.id)).toEqual(["u1", "a1", "e1"]);
    expect(checks).toEqual(["old1"]);
    expect(fake.written.map((line) => JSON.parse(line)).filter((m) => m.method === "thread/resume")).toEqual([
      expect.objectContaining({ params: { threadId: "old1", approvalPolicy: "never", sandbox: "danger-full-access" } }),
    ]);
    fake.notify("thread/status/changed", { threadId: "old1", status: { type: "active", activeFlags: [] } });
    await reg.observe("old1"); await reg.takeover("old1");
    expect((await reg.resume("old1")).status).toBe("running");
    await reg.sendMessage("old1", "继续原任务", "local-new-message");
    const messages = fake.written.map((line) => JSON.parse(line));
    expect(messages.find((m) => m.method === "turn/start").params).toMatchObject({ threadId: "old1", approvalPolicy: "never" });
    expect(messages.filter((m) => m.method === "thread/resume")).toHaveLength(1);
    expect(messages.some((m) => m.method === "thread/fork")).toBe(false);
    expect(bus.latestSeq("old1")).toBeGreaterThan(0);
    expect((await reg.list()).find((s) => s.id === "old1")?.desktopManaged).toBe(false);
  });

  test("原会话：没有 owner 探测或写锁核验失败，不以失联作为释放证据", async () => {
    const { reg, fake } = await setup(async () => { throw new DaemonError("IPC_UNAVAILABLE", "writer probe failed"); });
    await expect(reg.resume("old1")).rejects.toMatchObject({ code: "IPC_UNAVAILABLE" });
    reg.setDesktopManager(desktop());
    await expect(reg.resume("old1")).rejects.toMatchObject({ code: "IPC_UNAVAILABLE" });
    reg.setDesktopManager(desktop(async () => false));
    await expect(reg.resume("old1")).rejects.toMatchObject({ code: "IPC_UNAVAILABLE" });
    expect(fake.written.map((line) => JSON.parse(line).method)).not.toContain("thread/resume");
    expect((await reg.detail("old1")).session.controlMode).toBe("observe");
  });

  test("核验期间电脑重新打开，或恢复时出现写者冲突，都不解禁也不 fork", async () => {
    const { reg, fake } = await setup(async () => {});
    let discoveries = 0;
    reg.setDesktopManager(desktop(async () => ++discoveries > 1));
    await expect(reg.resume("old1")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(fake.written.map((line) => JSON.parse(line).method)).not.toContain("thread/resume");
    reg.setDesktopManager(desktop(async () => false));
    fake.resumeError = "thread already has an active writer";
    await expect(reg.resume("old1")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect((await reg.detail("old1")).session.controlMode).toBe("observe");
    await expect(reg.sendMessage("old1", "不能发送")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(fake.written.map((line) => JSON.parse(line).method)).not.toContain("thread/fork");
    fake.resumeError = null;
    expect((await reg.resume("old1")).controlMode).toBe("local");
  });

  test("create：白名单外路径拒绝", async () => {
    const { reg } = await setup();
    try {
      await reg.create({ projectPath: "C:\\Windows", approvalPolicy: "untrusted", prompt: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e instanceof DaemonError && e.code).toBe("PATH_NOT_ALLOWED");
    }
  });
});

/* ============ 4.3 审批 ============ */

describe("ApprovalService", () => {
  async function setup() {
    const fake = new FakeCodexServer();
    const bridge = new CodexBridge(fake);
    const bus = new SessionEventBus();
    const audit = new AuditStore(join(tmpRoot, "audit.db"));
    const approvals = new ApprovalService(bridge, bus, audit);
    const fs = new FsService([tmpRoot]);
    const reg = new SessionRegistry(bridge, bus, approvals, fs);
    await bridge.start();
    await reg.start();
    const events: SessionEvent[] = [];
    bus.subscribe("t1", null, (e) => events.push(e as SessionEvent));
    return { fake, bridge, bus, audit, approvals, reg, events };
  }

  test("提交 acceptForSession：回包 codex + 审计 + resolved 事件", async () => {
    const { fake, events, approvals, audit } = await setup();
    fake.send({
      jsonrpc: "2.0",
      id: 3,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: "t1",
        itemId: "exec-9",
        command: "npm install",
        cwd: tmpRoot,
        availableDecisions: ["accept", "cancel"],
      },
    });
    expect(events.find((e) => e.type === "approval.request")).toBeDefined();

    approvals.submit("t1", "exec-9", "acceptForSession", "demo");
    const last = JSON.parse(fake.written[fake.written.length - 1] as string);
    expect(last.result).toEqual({ decision: "acceptForSession" });
    expect(events.find((e) => e.type === "approval.resolved")).toBeDefined();

    const { entries } = audit.list(null, 10);
    expect(entries[0]).toMatchObject({ command: "npm install", decision: "acceptForSession" });
  });

  test("轮次结束作废：后续提交 → APPROVAL_EXPIRED", async () => {
    const { fake, approvals } = await setup();
    fake.send({
      jsonrpc: "2.0",
      id: 4,
      method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: "t1", itemId: "exec-10", command: "rm -rf x", cwd: tmpRoot, availableDecisions: ["accept"] },
    });
    approvals.expireSession("t1");
    try {
      approvals.submit("t1", "exec-10", "accept", "demo");
      expect.unreachable();
    } catch (e) {
      expect(e instanceof DaemonError && e.code).toBe("APPROVAL_EXPIRED");
    }
  });

  test("不存在 → APPROVAL_NOT_FOUND", async () => {
    const { approvals } = await setup();
    try {
      approvals.submit("t1", "nope", "accept", "demo");
      expect.unreachable();
    } catch (e) {
      expect(e instanceof DaemonError && e.code).toBe("APPROVAL_NOT_FOUND");
    }
  });
});

/* ============ 4.4 审计 ============ */

describe("AuditStore", () => {
  test("append + 倒序分页", () => {
    const store = new AuditStore(join(tmpRoot, "audit2.db"));
    for (let i = 1; i <= 25; i++) {
      store.append({
        at: 1000 + i,
        sessionId: `s${i}`,
        project: "demo",
        kind: "command",
        command: `cmd-${i}`,
        decision: "accept",
        source: "phone",
      });
    }
    const p1 = store.list(null, 10);
    expect(p1.entries[0]?.command).toBe("cmd-25");
    expect(p1.entries).toHaveLength(10);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = store.list(p1.nextCursor, 10);
    expect(p2.entries[0]?.command).toBe("cmd-15");
    store.close();
  });
});

/* ============ 4.5 白名单 fs ============ */

describe("FsService", () => {
  test("白名单内可列出，隐藏与 node_modules 过滤，目录优先", async () => {
    mkdirSync(join(tmpRoot, "webapp"));
    mkdirSync(join(tmpRoot, "webapp", "node_modules"));
    writeFileSync(join(tmpRoot, "webapp", "a.ts"), "x");
    writeFileSync(join(tmpRoot, "webapp", ".hidden"), "x");
    const fs = new FsService([tmpRoot]);
    const res = await fs.list(join(tmpRoot, "webapp"));
    expect(res.entries.map((e) => e.name)).toEqual(["a.ts"]);
    expect(res.entries[0]?.kind).toBe("file");
  });

  test("白名单外路径 → PATH_NOT_ALLOWED", () => {
    const fs = new FsService([tmpRoot]);
    expect(() => fs.resolveAllowed("C:\\Windows\\System32")).toThrow();
    try {
      fs.resolveAllowed("C:\\Windows");
      expect.unreachable();
    } catch (e) {
      expect(e instanceof DaemonError && e.code).toBe("PATH_NOT_ALLOWED");
    }
  });

  test("大小写不敏感（Windows）", () => {
    const fs = new FsService([tmpRoot.toUpperCase()]);
    expect(() => fs.resolveAllowed(join(tmpRoot, "sub"))).not.toThrow();
  });
});

/* ============ 事件总线补测（支撑 5.2 语义） ============ */

describe("SessionEventBus 补发与窗口", () => {
  test("lastSeq 补发 + 超窗 snapshot", () => {
    const bus = new SessionEventBus();
    for (let i = 0; i < 600; i++) bus.publish("s", { type: "error", message: `e${i}` });
    const l = () => {};
    const r1 = bus.subscribe("s", 590, l);
    expect(r1.ok && r1.replay.every((e) => e.seq > 590)).toBe(true);
    const r2 = bus.subscribe("s", 5, l);
    expect(r2.ok === false && r2.reason === "snapshot").toBe(true);
  });
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 文件占用，忽略 */
  }
});
