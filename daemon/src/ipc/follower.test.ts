import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { IpcClient, type PipeLikeSocket } from "./client";
import { IpcFollowerSession } from "./follower";
import type { ConversationState } from "./protocol";
import type { DesktopFact } from "./mapper";

class FakePipe implements PipeLikeSocket {
  written: Buffer[] = [];
  owner: string | null = "owner-1";
  commandErrors: string[] = [];
  replacementOwner: string | null = null;
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
    if (msg.type === "request" && msg.method === "initialize") {
      this.send({ type: "response", requestId: msg.requestId, result: { clientId: "al-1" } });
    } else if (msg.type === "request" && msg.method === "thread-owner-discovery") {
      if (msg.params.conversationId === "gone" || !this.owner) {
        this.send({ type: "response", requestId: msg.requestId, resultType: "notFound" });
      } else {
        this.send({ type: "response", requestId: msg.requestId, resultType: "success", handledByClientId: this.owner });
      }
    } else if (msg.type === "request") {
      const error = this.commandErrors.shift();
      if (error) {
        if (this.replacementOwner) this.owner = this.replacementOwner;
        this.send({ type: "response", requestId: msg.requestId, resultType: "error", error });
      } else {
        this.send({ type: "response", requestId: msg.requestId, result: { ok: true } });
      }
    }
  }
  send(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    this.dataCb?.(Buffer.concat([head, body]));
  }
  fireConnect(): void {
    this.connectCb?.();
  }
}

function setup() {
  const pipe = new FakePipe();
  const client = new IpcClient(() => pipe, { callTimeoutMs: 300, log: () => {} });
  client.connect();
  pipe.fireConnect();
  return { pipe, client };
}

function frames(pipe: FakePipe, method: string) {
  return pipe.written.map((d) => JSON.parse(d.subarray(4).toString("utf-8")))
    .filter((m) => m.method === method);
}

describe("IpcFollowerSession（2.1/2.3）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("发现拥有者并开始跟随；续订按 10s 周期", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    expect(f.ownerClientId).toBe("owner-1");

    const follows = () =>
      pipe.written.filter((d) => {
        const len = d.readUInt32LE(0);
        const m = JSON.parse(d.subarray(4, 4 + len).toString("utf-8"));
        return m.type === "broadcast" && m.method === "thread-stream-following-changed";
      });
    expect(follows().length).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(10_500);
    expect(follows().length).toBeGreaterThanOrEqual(2);
    f.stop();
    const last = follows().pop() as Buffer;
    const m = JSON.parse(last.subarray(4).toString("utf-8"));
    expect(m.params.following).toBe(false);
  });

  test("owner 反复发现失败 → ownerLost 回调", async () => {
    const { client } = setup();
    const f = new IpcFollowerSession(client, "gone");
    const lost = vi.fn();
    f.onOwnerLost = lost;
    for (let i = 0; i < 3; i++) {
      await f.discover().catch(() => {});
    }
    expect(lost).toHaveBeenCalledTimes(1);
    expect(f.ownerLost).toBe(true);
  });

  test("基准快照抑制事件；后续差分出事实；revision 回退触发重订阅", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    const facts: DesktopFact[] = [];
    f.onFacts = (fs) => facts.push(...fs);

    // 首个快照：基准（抑制差分，仅历史重建信号 + 状态）
    await f.handleStateChange({
      type: "snapshot",
      conversationState: {
        id: "c1",
        title: "T",
        revision: 5,
        turnHistory: { history: { entitiesByKey: {} } },
        requests: [],
      },
    });
    expect(f.lastState?.revision).toBe(5);
    expect(facts.filter((x) => x.kind !== "session.status" && x.kind !== "history.sync")).toHaveLength(0);
    expect(facts.some((x) => x.kind === "history.sync")).toBe(true);

    // 第二个快照：差分出事实
    await f.handleStateChange({
      type: "snapshot",
      conversationState: {
        id: "c1",
        title: "T",
        revision: 6,
        turnHistory: { history: { entitiesByKey: { t1: { turnId: "t1", status: "completed", items: [{ type: "agentMessage", text: "hi", status: "completed" }] } } } },
        requests: [],
      },
    });
    expect(facts.some((x) => x.kind === "agent.message")).toBe(true);

    // revision 回退的快照被拒绝
    facts.length = 0;
    await f.handleStateChange({
      type: "snapshot",
      conversationState: { id: "c1", revision: 4, turnHistory: { history: { entitiesByKey: {} } }, requests: [] },
    });
    expect(facts.length).toBe(0);

    // revision 回退的增量 → 重订阅重建（重发 following）
    const beforeFollow = pipe.written.filter((d) => d.includes(Buffer.from("following\":true"))).length;
    await f.handleStateChange({
      type: "patch",
      conversationState: { id: "c1", revision: 3, turnHistory: { history: { entitiesByKey: {} } }, requests: [] },
    });
    const afterFollow = pipe.written.filter((d) => d.includes(Buffer.from("following\":true"))).length;
    expect(afterFollow).toBeGreaterThan(beforeFollow);
  });

  test("重订阅后首个增量只作基准并通知 history.sync（不整史回流），后续差分恢复", async () => {
    const { client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    const facts: DesktopFact[] = [];
    f.onFacts = (fs) => facts.push(...fs);

    const cs = (revision: number, text?: string): ConversationState => ({
      id: "c1",
      revision,
      turnHistory: {
        history: {
          entitiesByKey: text
            ? { t1: { turnId: "t1", status: "completed", items: [{ type: "agentMessage", text, status: "completed" }] } }
            : {},
        },
      },
      requests: [],
    });

    // 建立基准（rev 5）
    await f.handleStateChange({ type: "snapshot", conversationState: cs(5) });
    // revision 回退的增量 → 重订阅（suppressNextDiff 置位，增量被吞）
    await f.handleStateChange({ type: "patch", conversationState: cs(4, "被丢弃的旧文本") });
    facts.length = 0;
    // 重订阅后首个到达的是增量（带全量状态、含完整文本）→ 只作基准 + history.sync
    await f.handleStateChange({ type: "patch", conversationState: cs(6, "完整文本") });
    expect(f.lastState?.revision).toBe(6);
    expect(facts.some((x) => x.kind === "history.sync")).toBe(true);
    expect(facts.some((x) => x.kind === "agent.message")).toBe(false); // 不整史回流
    // 后续快照差分恢复正常（文本增长照常产出）
    await f.handleStateChange({ type: "snapshot", conversationState: cs(7, "完整文本（已更新）") });
    expect(facts.some((x) => x.kind === "agent.message" && x.text === "完整文本（已更新）")).toBe(true);
  });

  test("委托操作：startTurn 携带幂等消息 ID 与显式策略", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    await f.startTurn({ text: "继续", clientUserMessageId: "msg-1", approvalPolicy: "untrusted" });
    const frames = pipe.written.map((d) => {
      const len = d.readUInt32LE(0);
      return JSON.parse(d.subarray(4, 4 + len).toString("utf-8"));
    });
    const sent = frames.find((m) => m.method === "thread-follower-start-turn");
    expect(sent.targetClientId).toBe("owner-1");
    expect(sent.version).toBe(2);
    expect(sent.params.turnStart.request).toMatchObject({
      clientUserMessageId: "msg-1",
      approvalPolicy: "untrusted",
    });
    expect(sent.params.turnStart.request.input[0]).toMatchObject({ type: "text", text: "继续" });
    expect(sent.params.turnStart.context.inheritThreadSettings).toBe(true);
    expect(sent.params.turnStart.request.threadId).toBe("c1");
  });

  test("手机发送继承桌面当前权限，不复制历史轮次或写入默认审批策略", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    await f.handleStateChange({
      type: "snapshot",
      conversationState: {
        id: "c1", revision: 1,
        latestThreadSettings: { approvalPolicy: "never" },
        turnHistory: { history: { entitiesByKey: { old: {
          turnId: "old", status: "completed", items: [],
          params: {
            approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" },
            permissions: ":read-only", approvalsReviewer: "user", model: "old-model",
          },
        } } } },
      },
    });
    await f.startTurn({ text: "继续", clientUserMessageId: "inherit-1" });
    const sent = frames(pipe, "thread-follower-start-turn")[0].params.turnStart;
    expect(sent.context).toEqual({ inheritThreadSettings: true });
    expect(sent.request).toEqual({
      threadId: "c1", clientUserMessageId: "inherit-1",
      input: [{ type: "text", text: "继续", text_elements: [] }],
    });
    f.stop();
  });

  test("审批决定与中断委托", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    await f.decideApproval("r1", "accept");
    await f.interruptTurn("t9");
    const frames = pipe.written.map((d) => {
      const len = d.readUInt32LE(0);
      return JSON.parse(d.subarray(4, 4 + len).toString("utf-8"));
    });
    expect(frames.find((m) => m.method === "thread-follower-command-approval-decision")?.params).toMatchObject({
      conversationId: "c1",
      requestId: "r1",
      decision: "accept",
    });
    expect(frames.find((m) => m.method === "thread-follower-interrupt-turn")?.params).toMatchObject({
      mode: "user-stop",
      expectedTurnId: "t9",
    });
  });

  test("桌面 owner 更换后发送使用新地址并重建基准", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    await f.handleStateChange({ type: "snapshot", conversationState: { id: "c1", revision: 5 } });
    pipe.owner = "owner-2";
    await f.startTurn({ text: "继续" });
    expect(frames(pipe, "thread-follower-start-turn")[0].targetClientId).toBe("owner-2");
    expect(f.lastState).toBeNull();
    await f.handleStateChange({ type: "snapshot", conversationState: { id: "c1", revision: 1 } });
    expect(f.lastState?.revision).toBe(1);
    f.stop();
  });

  test("发送时 owner 消失，清除旧地址且不发送到失效客户端", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    pipe.owner = null;
    await expect(f.startTurn({ text: "继续" })).rejects.toThrow("在 Codex 中打开原会话");
    expect(f.ownerClientId).toBeNull();
    expect(frames(pipe, "thread-follower-start-turn")).toHaveLength(0);
    f.stop();
  });

  test("路由 no-client-found 时重新发现并只重试一次，复用消息 ID", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    pipe.commandErrors = ["no-client-found"];
    pipe.replacementOwner = "owner-2";
    await f.startTurn({ text: "继续" });
    const sent = frames(pipe, "thread-follower-start-turn");
    expect(sent.map((m) => m.targetClientId)).toEqual(["owner-1", "owner-2"]);
    expect(sent[0].params.turnStart.request.clientUserMessageId)
      .toBe(sent[1].params.turnStart.request.clientUserMessageId);
    f.stop();
  });

  test("持续 no-client-found 报明确错误并标记失联，其他错误不自动重发", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    await f.start();
    const lost = vi.fn();
    f.onOwnerLost = lost;
    pipe.commandErrors = ["no-client-found", "no-client-found"];
    await expect(f.startTurn({ text: "继续" })).rejects.toThrow("重新打开原会话");
    expect(frames(pipe, "thread-follower-start-turn")).toHaveLength(2);
    expect(f.ownerLost).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
    pipe.commandErrors = ["request-version-mismatch"];
    await expect(f.startTurn({ text: "再次继续" })).rejects.toThrow("request-version-mismatch");
    expect(frames(pipe, "thread-follower-start-turn")).toHaveLength(3);
    f.stop();
  });

  test("首次发现失败后可在同一 follower 上重试启动", async () => {
    const { pipe, client } = setup();
    const f = new IpcFollowerSession(client, "c1");
    pipe.owner = null;
    await expect(f.start()).rejects.toThrow("IPC_OWNER_NOT_FOUND");
    pipe.owner = "owner-2";
    await f.start();
    expect(f.ownerClientId).toBe("owner-2");
    f.stop();
  });
});
