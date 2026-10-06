import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { IpcClient, type PipeLikeSocket } from "./client";
import { IpcFollowerSession } from "./follower";
import type { DesktopFact } from "./mapper";

class FakePipe implements PipeLikeSocket {
  written: Buffer[] = [];
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
      if (msg.params.conversationId === "gone") {
        this.send({ type: "response", requestId: msg.requestId, resultType: "notFound" });
      } else {
        this.send({ type: "response", requestId: msg.requestId, resultType: "success", handledByClientId: "owner-1" });
      }
    } else if (msg.type === "request") {
      this.send({ type: "response", requestId: msg.requestId, result: { ok: true } });
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

    // 首个快照：基准（抑制差分，仅状态）
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
    expect(facts.filter((x) => x.kind !== "session.status")).toHaveLength(0);

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
});
