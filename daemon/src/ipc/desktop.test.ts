import { afterEach, beforeEach, describe, expect, test, setSystemTime, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@agentlink/shared";
import { CodexBridge, DaemonError } from "../codex/bridge";
import { SessionEventBus } from "../events/bus";
import { AuditStore } from "../domain/audit";
import { ApprovalService } from "../domain/approvals";
import { SessionRegistry } from "../domain/sessions";
import { FsService } from "../domain/fs";
import { FakeCodexServer } from "../testing/fake-codex";
import { IpcClient, type PipeLikeSocket } from "./client";
import { DesktopSessionManager } from "./desktop-manager";
import { ControlStore } from "../domain/control-store";

/** 管理器测试用假管道：应答 + 可注入状态推送 */
class FakePipe implements PipeLikeSocket {
  written: Buffer[] = [];
  ownerAvailable = true;
  discoveryError: unknown = "no-client-found";
  autoSnapshot: unknown = null;
  private dataCb: ((d: Buffer) => void) | null = null;
  private connectCb: (() => void) | null = null;
  on(event: string, cb: (...a: never[]) => void): unknown {
    if (event === "data") this.dataCb = cb as (d: Buffer) => void;
    if (event === "connect") this.connectCb = cb as () => void;
    return this;
  }
  write(data: Buffer): boolean {
    this.written.push(data);
    this.handle(data);
    return true;
  }
  destroy(): void {}
  private handle(data: Buffer): void {
    const len = data.readUInt32LE(0);
    const msg = JSON.parse(data.subarray(4, 4 + len).toString("utf-8"));
    if (msg.type === "broadcast" && msg.params?.following && this.autoSnapshot) {
      this.pushState(msg.params.conversationId, this.autoSnapshot);
    }
    if (msg.type !== "request") return;
    if (msg.method === "initialize") {
      this.send({ type: "response", requestId: msg.requestId, result: { clientId: "al-mgr" } });
    } else if (msg.method === "thread-owner-discovery") {
      this.send(this.ownerAvailable
        ? { type: "response", requestId: msg.requestId, resultType: "success", handledByClientId: "owner-1" }
        : { type: "response", requestId: msg.requestId, resultType: "error", error: this.discoveryError });
    } else {
      this.send({ type: "response", requestId: msg.requestId, result: { ok: true } });
    }
  }
  send(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    this.dataCb?.(Buffer.concat([head, body]));
  }
  pushState(conversationId: string, change: unknown): void {
    this.send({ type: "broadcast", params: { conversationId, change } });
  }
  frames(): Array<Record<string, unknown>> {
    return this.written.map((d) => {
      const len = d.readUInt32LE(0);
      return JSON.parse(d.subarray(4, 4 + len).toString("utf-8"));
    });
  }
  fireConnect(): void {
    this.connectCb?.();
  }
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "al-desktop-"));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function setup(opts: { summaryTimeoutMs?: number; controls?: ControlStore } = {}) {
  const fake = new FakeCodexServer();
  const bridge = new CodexBridge(fake);
  const bus = new SessionEventBus();
  const audit = new AuditStore(join(tmp, "a.db"));
  const approvals = new ApprovalService(bridge, bus, audit);
  const fs = new FsService([tmp]);
  const registry = new SessionRegistry(bridge, bus, approvals, fs);
  const pipe = new FakePipe();
  const manager = new DesktopSessionManager(bus, approvals, {
    ...opts,
    log: () => {},
    clientFactory: () => {
      const c = new IpcClient(() => pipe, { callTimeoutMs: 300, log: () => {} });
      return c;
    },
  });
  approvals.desktopDelegate = {
    decide: (sid, rid, dec, kind) => manager.decide(sid, rid, dec, kind),
  };
  registry.setDesktopManager(manager);
  await bridge.start();
  await registry.start();
  // 客户端懒连接：触发一次 observe 前 pipe 未连接；这里预连接
  // （manager.ensureClient 在首次 observe 时 connect + fireConnect 由真实 socket 触发，
  //  假管道需要手动 fire—— observe 后统一 fire）
  const events: SessionEvent[] = [];
  bus.subscribe("old1", null, (e) => events.push(e as SessionEvent));
  return { fake, bridge, bus, audit, approvals, registry, manager, pipe, events };
}

const snap = (revision: number, items: unknown[], requests: unknown[] = []) => ({
  type: "snapshot",
  conversationState: {
    id: "old1",
    title: "桌面任务",
    revision,
    turnHistory: { history: { entitiesByKey: { tt: { turnId: "tt", status: "completed", items } } } },
    requests,
  },
});

/** 推一个基准快照（被抑制，仅建基准）再推变化 */
async function pushBase(pipe: Awaited<ReturnType<typeof setup>>["pipe"]) {
  pipe.pushState("old1", snap(1, []));
  await new Promise((r) => setTimeout(r, 15));
}

describe("桌面接管链路（任务 3.1-3.4 / 4.1-4.2）", () => {
  test("following 等非状态广播不会触发重订阅循环", async () => {
    const { manager, pipe, bridge } = await setup();
    const observing = manager.observe("old1"); pipe.fireConnect(); await observing;
    const count = pipe.frames().length;
    pipe.send({ type: "broadcast", method: "thread-stream-following-changed", params: { conversationId: "old1", following: true } });
    await Promise.resolve(); await Promise.resolve();
    expect(pipe.frames()).toHaveLength(count);
    manager.shutdown(); bridge.stop();
  });
  test("旧历史查询等待期间桌面已同步，迟到查询不能用旧内容和新水位覆盖快照", async () => {
    const { bridge, registry, manager, pipe } = await setup();
    let finish!: (value: { data: [] }) => void;
    const pending = spyOn(bridge, "threadTurns").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    try {
      const request = registry.detail("old1");
      const observation = manager.observe("old1"); pipe.fireConnect(); await observation;
      pipe.pushState("old1", snap(1, [
        { id: "user", type: "userMessage", text: "新指令" },
        { id: "reply", type: "agentMessage", text: "新回复" },
      ]));
      finish({ data: [] });
      const detail = await request;
      expect(detail.session.history.map((item) => item.id)).toEqual(["user", "reply"]);
      expect(detail.latestSeq).toBeGreaterThan(0);
    } finally { pending.mockRestore(); manager.shutdown(); bridge.stop(); }
  });
  test("后台重新装配从持久记录恢复接管；释放观察只清除控制状态，不中断任务", async () => {
    const controls = new ControlStore();
    const first = await setup({ controls });
    const p = first.registry.takeover("old1"); first.pipe.fireConnect(); await p;
    expect(controls.controls()).toEqual([{ sessionId: "old1", mode: "takeover" }]);
    const restored = await setup({ controls });
    const observing = restored.registry.observe("old1"); restored.pipe.fireConnect(); await observing;
    expect(restored.manager.isTakenOver("old1")).toBe(true);
    restored.manager.stop("old1");
    expect(controls.controls()).toEqual([]);
    expect(restored.pipe.frames().some((f) => f.method === "thread-follower-interrupt-turn")).toBe(false);
    first.manager.stop("old1"); controls.close();
  });
  test("首页已经收到审批后新开详情仍含待审批快照；审批消失后详情也移除", async () => {
    const { registry, manager, pipe } = await setup();
    const observation = registry.observe("old1", "takeover");
    pipe.fireConnect();
    await observation;
    pipe.pushState("old1", snap(1, [], [{ id: 2, method: "item/fileChange/requestApproval", params: { cwd: "F:/x" } }]));
    const detail = await registry.detail("old1");
    expect(detail.session).toMatchObject({ controlMode: "takeover", approvals: [{ approvalId: "2", kind: "fileChange" }] });
    expect(detail.latestSeq).toBeGreaterThan(0);
    pipe.pushState("old1", snap(2, []));
    expect((await registry.detail("old1")).session.approvals).toEqual([]);
    manager.stop("old1");
  });
  test("管道未就绪时列表有整体等待上限，不会把未知状态当作空闲", async () => {
    const { registry, manager } = await setup({ summaryTimeoutMs: 60 });
    const started = Date.now();
    const [first, concurrent] = await Promise.all([registry.list(), registry.list()]);
    expect(Date.now() - started).toBeLessThan(500);
    expect(first.find((s) => s.id === "old1")?.status).toBe("unknown");
    expect(concurrent.find((s) => s.id === "old1")?.status).toBe("unknown");
    (manager as unknown as { client: IpcClient }).client.disconnect();
  });

  test("只打开首页：首次列表等待真实运行首帧，且不恢复原会话、不发任务", async () => {
    const { registry, manager, pipe, fake } = await setup();
    pipe.autoSnapshot = { type: "snapshot", conversationState: {
      id: "old1", revision: 1, requests: [], turnHistory: { history: { entitiesByKey: {
        active: { turnId: "active", status: "inProgress", items: [] },
      } } },
    } };
    const list = registry.list();
    await new Promise((r) => setTimeout(r, 0));
    pipe.fireConnect();
    expect((await list).find((s) => s.id === "old1")).toMatchObject({ status: "running" });
    const methods = fake.written.map((s) => JSON.parse(s).method);
    expect(methods).not.toContain("thread/resume");
    expect(methods).not.toContain("turn/start");
    const before = pipe.frames().filter((f) => f.method === "thread-owner-discovery").length;
    await registry.list();
    expect(pipe.frames().filter((f) => f.method === "thread-owner-discovery")).toHaveLength(before);
    manager.stop("old1");
  });

  test("拥有者缺失返回未知，已知状态过期或管道断开也不能显示空闲", async () => {
    const { registry, manager, pipe } = await setup();
    pipe.ownerAvailable = false;
    const list = registry.list();
    await new Promise((r) => setTimeout(r, 0));
    pipe.fireConnect();
    expect((await list).find((s) => s.id === "old1")).toMatchObject({ status: "unknown", desktopGone: true });
    pipe.ownerAvailable = true;
    await registry.observe("old1");
    pipe.pushState("old1", snap(1, []));
    expect(manager.overlay().get("old1")?.status).toBe("done");
    try {
      setSystemTime(Date.now() + 26_000);
      expect(manager.overlay().get("old1")?.status).toBe("unknown");
    } finally { setSystemTime(); }
    (manager as unknown as { client: IpcClient }).client.disconnect();
    expect(manager.overlay().get("old1")).toMatchObject({ status: "unknown", desktopGone: true });
    manager.stop("old1");
  });

  test("首帧活动轮次立即显示运行中；列表轮询不覆盖状态，完成推送使用新快照", async () => {
    const { registry, manager, pipe, bus, events } = await setup();
    const summaries: Array<{ status: string }> = [];
    bus.subscribeList((e) => { if (e.type === "session.updated") summaries.push(e.summary); });
    const p = registry.observe("old1");
    pipe.fireConnect();
    await p;
    pipe.pushState("old1", {
      type: "snapshot", conversationState: { id: "old1", revision: 1,
        turnHistory: { history: { entitiesByKey: {
          active: { turnId: "active", status: "inProgress", items: [] },
          tail: { status: "completed", items: [] },
        } } }, requests: [],
      },
    });
    expect(events.filter((e) => e.type === "session.status").at(-1)).toMatchObject({ status: "running" });
    expect((await registry.list()).find((s) => s.id === "old1")?.status).toBe("running");
    expect((await registry.list()).find((s) => s.id === "old1")?.status).toBe("running");
    pipe.pushState("old1", snap(2, []));
    expect(summaries.at(-1)?.status).toBe("done");
    expect((await registry.detail("old1")).session.status).toBe("done");
    manager.stop("old1");
  });

  test("首帧真实数字 ID 审批同步到列表和手机审批事件", async () => {
    const { registry, manager, pipe, events } = await setup();
    const p = registry.observe("old1");
    pipe.fireConnect();
    await p;
    pipe.pushState("old1", snap(1, [], [{ id: 2, method: "item/commandExecution/requestApproval",
      params: { command: "npm install", cwd: "F:/x", availableDecisions: ["accept", "decline"] },
    }]));
    expect(events.find((e) => e.type === "approval.request")).toMatchObject({ approvalId: "2", command: "npm install" });
    const summary = (await registry.list()).find((s) => s.id === "old1");
    expect(summary).toMatchObject({ status: "waiting_approval", pendingApprovals: 1 });
    manager.stop("old1");
  });

  test("ownerAlive：只有明确无 owner 才返回 false；检测异常或断线必须拒绝", async () => {
    const { manager, pipe } = await setup();
    const p = manager.ownerAlive("old1");
    pipe.fireConnect();
    expect(await p).toBe(true);
    pipe.ownerAvailable = false;
    expect(await manager.ownerAlive("old1")).toBe(false);
    pipe.discoveryError = { message: "ipc closed" };
    await expect(manager.ownerAlive("old1")).rejects.toThrow("IPC_UNAVAILABLE");
    pipe.discoveryError = null;
    await expect(manager.ownerAlive("old1")).rejects.toThrow("IPC_UNAVAILABLE");
    (manager as unknown as { client: IpcClient }).client.disconnect();
    await expect(manager.ownerAlive("old1")).rejects.toThrow("IPC_UNAVAILABLE");
  });

  test("observe → 基准后快照差分事件流出（agent.message/状态/历史直出）", async () => {
    const { registry, pipe, events } = await setup();
    const p = registry.observe("old1");
    pipe.fireConnect();
    await p;
    await pushBase(pipe);
    // 历史由快照直出（detail），事件流只承载后续变化
    pipe.pushState(
      "old1",
      snap(2, [{ type: "agentMessage", text: "桌面正在干活", status: "completed" }]),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === "agent.message")).toBe(true);
    expect(events[events.length - 1]?.type).toBe("session.status");
  });

  test("takeover 后发消息走 IPC 委托（含幂等 ID 复用），不走 app-server", async () => {
    const { registry, pipe, fake } = await setup();
    const p = registry.observe("old1", "takeover");
    pipe.fireConnect();
    await p;
    await registry.sendMessage("old1", "继续干活", "message-1");
    await registry.sendMessage("old1", "继续干活", "message-1"); // 重试相同 ID 不再次委托
    await registry.sendMessage("old1", "继续干活", "message-2"); // 同文本新意图仍可发送
    const turns = pipe.frames().filter((m) => m.method === "thread-follower-start-turn");
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      const start = (turn.params as { turnStart: { request: Record<string, unknown>; context: Record<string, unknown> } }).turnStart;
      expect(start.context.inheritThreadSettings).toBe(true);
      expect(start.request).not.toHaveProperty("approvalPolicy");
      expect(start.request).not.toHaveProperty("sandboxPolicy");
      expect(start.request).not.toHaveProperty("permissions");
      expect(start.request.threadId).toBe("old1");
    }
    expect(turns.map((turn) => (turn.params as { turnStart: { request: { clientUserMessageId: string } } }).turnStart.request.clientUserMessageId)).toEqual(["message-1", "message-2"]);
    // app-server 侧不应收到 turn/start
    expect(fake.written.some((w) => w.includes("turn/start"))).toBe(false);
  });

  test("审批桥接：requests 差分 → 事件；提交 → 委托 + 审计；幂等与冲突", async () => {
    const { registry, pipe, approvals, audit, events } = await setup();
    const p = registry.observe("old1", "takeover");
    pipe.fireConnect();
    await p;
    await pushBase(pipe);
    pipe.pushState(
      "old1",
      snap(2, [], [
        { id: "r1", kind: "command", command: "npm install", cwd: "F:/x", availableDecisions: ["accept", "cancel"] },
      ]),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === "approval.request")).toBe(true);

    approvals.submit("old1", "r1", "accept", "demo");
    await new Promise((r) => setTimeout(r, 10));
    const dec = pipe.frames().find((m) => m.method === "thread-follower-command-approval-decision");
    expect(dec?.params).toMatchObject({ conversationId: "old1", requestId: "r1", decision: "accept" });
    const { entries } = audit.list(null, 10);
    expect(entries[0]).toMatchObject({ decision: "accept", source: "desktop-delegate" });

    // 幂等：同决定重复提交不报错；不同决定 → APPROVAL_ALREADY_DECIDED
    expect(() => approvals.submit("old1", "r1", "accept", "demo")).not.toThrow();
    try {
      approvals.submit("old1", "r1", "decline", "demo");
      expect.unreachable();
    } catch (e) {
      expect(e instanceof DaemonError && e.code).toBe("APPROVAL_ALREADY_DECIDED");
    }
  });

  test("电脑端已处理的审批 → resolved_elsewhere", async () => {
    const { registry, pipe, events } = await setup();
    const p = registry.observe("old1");
    pipe.fireConnect();
    await p;
    await pushBase(pipe);
    pipe.pushState("old1", snap(2, [], [{ id: "r2", kind: "command", command: "rm x", cwd: "F:/x" }]));
    await new Promise((r) => setTimeout(r, 20));
    pipe.pushState("old1", snap(3, [])); // requests 消失
    await new Promise((r) => setTimeout(r, 20));
    const resolved = events.find((e) => e.type === "approval.resolved");
    expect(resolved).toMatchObject({ approvalId: "r2", decision: "resolved_elsewhere" });
  });

  test("owner 发现失败不会残留观察会话，恢复后可以重新接管", async () => {
    const { registry, manager, pipe } = await setup();
    pipe.ownerAvailable = false;
    const p = registry.observe("nobody");
    pipe.fireConnect();
    await expect(p).rejects.toThrow("IPC_OWNER_NOT_FOUND");
    expect(manager.has("nobody")).toBe(false);
    pipe.ownerAvailable = true;
    await registry.takeover("nobody");
    expect(manager.isTakenOver("nobody")).toBe(true);
    manager.stop("nobody");
  });

  test("既有观察会话失去 owner 时接管不虚报成功", async () => {
    const { registry, manager, pipe } = await setup();
    const p = registry.observe("old1");
    pipe.fireConnect();
    await p;
    pipe.ownerAvailable = false;
    await expect(registry.takeover("old1")).rejects.toThrow("IPC_OWNER_NOT_FOUND");
    expect(manager.isTakenOver("old1")).toBe(false);
    manager.stop("old1");
  });

  test("fork 兜底：新会话带谱系，旧会话 forkedToId 指向新会话", async () => {
    const { registry } = await setup();
    const forkId = await registry.fork("old1", "untrusted");
    expect(forkId).toBe("fork-1");
    const list = await registry.list();
    const forkSession = list.find((s) => s.id === "fork-1");
    const origin = list.find((s) => s.id === "old1");
    expect(forkSession?.forkedFromId).toBe("old1");
    expect(origin?.forkedToId).toBe("fork-1");
    expect(forkSession?.title).toContain("接力");
  });
});
