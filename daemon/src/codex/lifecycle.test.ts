import { describe, expect, test } from "bun:test";
import { CodexBridge } from "./bridge";
import type { CodexTransportFactory } from "./process";

describe("app-server 就绪与停止", () => {
  test("初始化失败不能报告就绪，停止后取消重启并清理传输", async () => {
    let spawns = 0, kills = 0;
    const factory: CodexTransportFactory = { create: (data) => {
      spawns++;
      return { write: (line) => { const msg = JSON.parse(line); data(JSON.stringify({ id: msg.id, error: { code: -1, message: "initialize rejected" } }) + "\n"); }, kill: () => { kills++; }, onExit: () => {} };
    } };
    const bridge = new CodexBridge(factory);
    await expect(bridge.start()).rejects.toThrow("initialize rejected");
    expect(bridge.ready).toBe(false);
    bridge.stop();
    await new Promise((r) => setTimeout(r, 550));
    expect(spawns).toBe(1); expect(kills).toBeGreaterThan(0);
  });

  test("子进程退出会清理挂起请求并失去就绪状态", async () => {
    let exit!: (code: number | null) => void;
    const bridge = new CodexBridge({ create: (data) => ({
      write: (line) => { const msg = JSON.parse(line); if (msg.method === "initialize") data(JSON.stringify({ id: msg.id, result: {} }) + "\n"); },
      kill: () => {}, onExit: (cb) => { exit = cb; },
    }) });
    await bridge.start(); expect(bridge.ready).toBe(true);
    const pending = bridge.threadList(); exit(1);
    await expect(pending).rejects.toThrow("connection closed");
    expect(bridge.ready).toBe(false);
    bridge.stop();
  });
});
