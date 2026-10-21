import { describe, expect, test } from "bun:test";
import { IpcFramer } from "./framer";

function frame(body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

describe("IPC 帧隔离与长会话", () => {
  test("超过旧 64 MiB 上限的合法帧可分块读取，后续帧继续到达", () => {
    const received: string[] = [];
    const dropped: number[] = [];
    const reader = new IpcFramer((body) => received.push(JSON.parse(body.toString()).id), (bytes) => dropped.push(bytes));
    const body = Buffer.alloc(64 * 1024 * 1024 + 1024, 32);
    body.write('{"id":"long-session"}');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    reader.push(header.subarray(0, 1)); reader.push(header.subarray(1));
    for (let at = 0; at < body.length; at += 65536) reader.push(body.subarray(at, at + 65536));
    reader.push(frame(Buffer.from('{"id":"other-session"}')));
    expect(received).toEqual(["long-session", "other-session"]);
    expect(dropped).toEqual([]);
  });

  test("超限帧跨块丢弃且不解释正文中的伪帧，后续合法帧正常到达", () => {
    const received: string[] = [];
    const dropped: number[] = [];
    const reader = new IpcFramer((body) => received.push(body.toString()), (bytes) => dropped.push(bytes), 64);
    const large = Buffer.alloc(200, 0);
    frame(Buffer.from("forged-frame")).copy(large, 9);
    const bytes = Buffer.concat([frame(large), frame(Buffer.from("valid-frame")), frame(Buffer.from("next-frame"))]);
    for (let at = 0; at < bytes.length; at += 7) reader.push(bytes.subarray(at, at + 7));
    expect(dropped).toEqual([200]);
    expect(received).toEqual(["valid-frame", "next-frame"]);
  });

  test("断开清理残留正文与帧头，回调断开时同块旧数据不能进入新连接", () => {
    const received: string[] = [];
    const reader = new IpcFramer((body) => { received.push(body.toString()); reader.reset(); }, () => {});
    const unfinished = frame(Buffer.from("unfinished"));
    reader.push(unfinished.subarray(0, 6)); reader.reset();
    reader.push(Buffer.concat([frame(Buffer.from("new")), frame(Buffer.from("late-old"))]));
    expect(received).toEqual(["new"]);
    reader.push(frame(Buffer.from("newer")));
    expect(received).toEqual(["new", "newer"]);
  });
});
