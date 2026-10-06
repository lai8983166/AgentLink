import { describe, expect, test } from "bun:test";
import { IpcClient, type PipeLikeSocket } from "./client";
import type { IpcBroadcast } from "./protocol";

/** 可编程假管道：解析帧、模拟桌面应答与推送 */
class FakePipe implements PipeLikeSocket {
  written: Buffer[] = [];
  private dataCb: ((d: Buffer) => void) | null = null;
  private connectCb: (() => void) | null = null;
  destroyed = false;

  on(event: string, cb: (...a: never[]) => void): unknown {
    if (event === "data") this.dataCb = cb as (d: Buffer) => void;
    if (event === "connect") this.connectCb = cb as () => void;
    return this;
  }
  write(data: Buffer): boolean {
    this.written.push(data);
    this.handleServer(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.dataCb = null;
  }

  /** 解析最近一帧并模拟桌面 */
  private handleServer(data: Buffer): void {
    const len = data.readUInt32LE(0);
    const msg = JSON.parse(data.subarray(4, 4 + len).toString("utf-8"));
    if (msg.type === "request") {
      if (msg.method === "initialize") {
        this.serverSend({ type: "response", requestId: msg.requestId, result: { clientId: "desktop-1", codexCli: "0.160.0" } });
      } else if (msg.method === "thread-owner-discovery") {
        this.serverSend({
          type: "response",
          requestId: msg.requestId,
          resultType: "success",
          handledByClientId: "owner-9",
        });
      } else {
        this.serverSend({ type: "response", requestId: msg.requestId, result: { ok: true } });
      }
    }
  }

  serverSend(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    this.dataCb?.(Buffer.concat([head, body]));
  }

  /** 分片喂入（测分帧） */
  feedChunked(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    const full = Buffer.concat([head, body]);
    const mid = Math.floor(full.length / 2);
    this.dataCb?.(full.subarray(0, mid));
    this.dataCb?.(full.subarray(mid));
  }

  fireConnect(): void {
    this.connectCb?.();
  }
}

function lastFrame(pipe: FakePipe): Record<string, unknown> {
  const d = pipe.written[pipe.written.length - 1] as Buffer;
  const len = d.readUInt32LE(0);
  return JSON.parse(d.subarray(4, 4 + len).toString("utf-8"));
}

function setup() {
  const pipes: FakePipe[] = [];
  const factory = () => {
    const p = new FakePipe();
    pipes.push(p);
    return p;
  };
  const client = new IpcClient(factory, { callTimeoutMs: 500, log: () => {} });
  client.connect();
  pipes[0]!.fireConnect();
  return { client, pipes };
}

describe("IpcClient（任务 1.1/1.2）", () => {
  test("握手取得 clientId 并记录对端信息", async () => {
    const { client } = setup();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.clientId).toBe("desktop-1");
    expect((client.peerInfo as { codexCli?: string })?.codexCli).toBe("0.160.0");
    expect(client.state).toBe("open");
  });

  test("分片到达正确分帧", async () => {
    const { client, pipes } = setup();
    await new Promise((r) => setTimeout(r, 10));
    const p = pipes[0]!;
    const got: string[] = [];
    client.broadcastHandler = (b) => got.push(String((b.params as { x?: string })?.x));
    p.feedChunked({ type: "broadcast", params: { x: "分片OK" } });
    expect(got).toEqual(["分片OK"]);
  });

  test("request 携带版本号与 targetClientId；owner-discovery 返回 handledByClientId", async () => {
    const { client, pipes } = setup();
    await new Promise((r) => setTimeout(r, 10));
    const p = client.callFull("thread-owner-discovery", {
      hostId: "local",
      conversationId: "c1",
    });
    const sent = lastFrame(pipes[0]!);
    expect(sent.version).toBe(1);
    const res = await p;
    expect((res as { handledByClientId?: string }).handledByClientId).toBe("owner-9");
  });

  test("client-discovery-request 自动回应 canHandle:false", async () => {
    const { client, pipes } = setup();
    await new Promise((r) => setTimeout(r, 10));
    (pipes[0] as unknown as FakePipe).serverSend({ type: "client-discovery-request", requestId: "r1" });
    const reply = lastFrame(pipes[0]!);
    expect(reply).toMatchObject({ type: "client-discovery-response", requestId: "r1", response: { canHandle: false } });
  });

  test("broadcast 分发到 handler", () => {
    const { client, pipes } = setup();
    const got: IpcBroadcast[] = [];
    client.broadcastHandler = (b) => got.push(b);
    (pipes[0] as unknown as FakePipe).serverSend({
      type: "broadcast",
      params: { conversationId: "c1", change: { type: "snapshot", conversationState: { id: "c1" } } },
    });
    expect(got[0]?.params?.conversationId).toBe("c1");
  });

  test("断线后重连并重新握手", async () => {
    const { client, pipes } = setup();
    await new Promise((r) => setTimeout(r, 10));
    let reconnected = false;
    client.onConnected = () => {
      reconnected = true;
    };
    // 模拟管道对象关闭（destroy 触发 close 语义：这里手动调 handle 收尾）
    (pipes[0] as unknown as FakePipe).destroy();
    // FakePipe.destroy 不触发 close 回调，直接驱动 client 内部重连路径：
    (client as unknown as { handleClose: () => void }).handleClose();
    await new Promise((r) => setTimeout(r, 600)); // 退避 500ms
    pipes[1]?.fireConnect();
    await new Promise((r) => setTimeout(r, 20));
    expect(pipes.length).toBe(2);
    expect(reconnected).toBe(true);
    expect(client.state).toBe("open");
  });
});

describe("对端信息落盘（任务 1.2）", () => {
  test("savePeerInfo/readPeerInfo 往返", () => {
    const { mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const home = `${process.env.TEMP ?? "/tmp"}/agentlink-home-${Date.now()}`;
    mkdirSync(home, { recursive: true });
    const origProfile = process.env.USERPROFILE;
    const origHome = process.env.HOME;
    process.env.USERPROFILE = home; // 单一赋值，无 undefined 窗口
    const { savePeerInfo, readPeerInfo, peerInfoPath } = require("./peer-info") as typeof import("./peer-info");
    savePeerInfo({ codexCli: "0.160.0" });
    // 路径须落在注入的 home 内（两边都用 join 归一，避免 /tmp 与 \tmp 差异）
    const { join: joinPath } = require("node:path") as typeof import("node:path");
    expect(peerInfoPath().startsWith(joinPath(home, ".agentlink"))).toBe(true);
    const read = readPeerInfo();
    expect(read?.peer).toMatchObject({ codexCli: "0.160.0" });
    expect(read?.at).toBeGreaterThan(0);
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});
