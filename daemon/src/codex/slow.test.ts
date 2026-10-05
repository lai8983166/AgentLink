import { describe, expect, test } from "bun:test";
import { CodexBridge } from "./bridge";
import { createRealTransportFactory } from "./process";

/** 真连 codex 的集成测试：AGENTLINK_SLOW_TESTS=1 bun test（消耗少量额度） */
const SLOW = !!process.env.AGENTLINK_SLOW_TESTS;

describe.skipIf(!SLOW)("CodexBridge 真连集成（slow）", () => {
  test("initialize + threadList + threadStart + turns 全链路", async () => {
    const bridge = new CodexBridge(createRealTransportFactory());
    await bridge.start();

    const threads = await bridge.threadList();
    expect(Array.isArray(threads)).toBe(true);
    expect(threads.length).toBeGreaterThan(0); // 本机已有历史会话

    const id = await bridge.threadStart({
      cwd: import.meta.dir,
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(id).toBeTruthy();

    const turns = await bridge.threadTurns(id);
    expect(turns).toBeDefined();

    bridge.stop();
  }, 60000);
});
