import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FakeableSocket } from "./ws";
import { WsClient } from "./ws";

/** 可控假 socket */
class FakeSocket implements FakeableSocket {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
  serverSend(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const client = new WsClient(
    () => "ws://x/ws?token=t",
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  );
  client.connect();
  sockets[0]!.onopen?.();
  return { client, sockets };
}

describe("WsClient（任务 7.2）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("订阅发送 subscribe（无历史时 lastSeq=null）", () => {
    const { client, sockets } = setup();
    client.subscribe("s1", () => {});
    const sent = sockets[0]!.sent.map((x) => JSON.parse(x));
    expect(sent).toContainEqual({ type: "subscribe", sessionId: "s1", lastSeq: null });
  });

  test("事件分发 + 序号水位推进", () => {
    const { client, sockets } = setup();
    const seen: Array<{ seq: number }> = [];
    client.subscribe("s1", (e) => seen.push(e as { seq: number }));
    sockets[0]!.serverSend({ type: "event", event: { sessionId: "s1", seq: 1, at: 1, type: "error", message: "a" } });
    sockets[0]!.serverSend({ type: "event", event: { sessionId: "s1", seq: 2, at: 1, type: "error", message: "b" } });
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("断线重连后带 lastSeq 重新订阅（补发语义）", () => {
    const { client, sockets } = setup();
    client.subscribe("s1", () => {});
    sockets[0]!.serverSend({ type: "event", event: { sessionId: "s1", seq: 5, at: 1, type: "error", message: "x" } });

    sockets[0]!.close(); // 断线 → 1s 退避
    expect(client.state).toBe("closed");
    vi.advanceTimersByTime(1100);

    expect(sockets).toHaveLength(2);
    sockets[1]!.onopen?.(); // 新 socket 打开 → 重订阅
    const sent = sockets[1]!.sent.map((x) => JSON.parse(x));
    expect(sent).toContainEqual({ type: "subscribe", sessionId: "s1", lastSeq: 5 });
  });

  test("snapshot.required 清水位并回调", () => {
    const { client, sockets } = setup();
    const cb = vi.fn();
    client.onSnapshotRequired = cb;
    client.subscribe("s1", () => {});
    sockets[0]!.serverSend({ type: "event", event: { sessionId: "s1", seq: 3, at: 1, type: "error", message: "x" } });
    sockets[0]!.serverSend({ type: "snapshot.required", sessionId: "s1" });
    expect(cb).toHaveBeenCalledWith("s1");
  });

  test("退避重连后快照回调触发的重新订阅从 null 开始", () => {
    const { client, sockets } = setup();
    client.subscribe("s1", () => {});
    sockets[0]!.serverSend({ type: "event", event: { sessionId: "s1", seq: 9, at: 1, type: "error", message: "x" } });
    sockets[0]!.serverSend({ type: "snapshot.required", sessionId: "s1" });
    sockets[0]!.close();
    vi.advanceTimersByTime(1100);
    sockets[1]!.onopen?.();
    const sent = sockets[1]!.sent.map((x) => JSON.parse(x));
    expect(sent).toContainEqual({ type: "subscribe", sessionId: "s1", lastSeq: null });
  });

  test("列表订阅与退订", () => {
    const { client, sockets } = setup();
    const seen: unknown[] = [];
    const unsub = client.subscribeList((e) => seen.push(e));
    sockets[0]!.serverSend({
      type: "listEvent",
      event: { sessionId: "__all__", seq: 1, at: 1, type: "session.created", summary: { id: "x" } },
    });
    unsub();
    sockets[0]!.serverSend({
      type: "listEvent",
      event: { sessionId: "__all__", seq: 2, at: 1, type: "session.created", summary: { id: "y" } },
    });
    expect(seen).toHaveLength(1);
    expect(sockets[0]!.sent).toContainEqual(JSON.stringify({ type: "unsubscribeList" }));
  });
});
