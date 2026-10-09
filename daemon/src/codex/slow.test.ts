import { describe, expect, test } from "bun:test";
import { CodexBridge } from "./bridge";
import { createRealTransportFactory } from "./process";

/** 真连 codex 的只读兼容性测试：AGENTLINK_SLOW_TESTS=1 bun test */
const SLOW = !!process.env.AGENTLINK_SLOW_TESTS;

describe.skipIf(!SLOW)("CodexBridge 真连集成（slow）", () => {
  test("只读 initialize + threadList + 既有历史，不创建或恢复会话", async () => {
    const bridge = new CodexBridge(createRealTransportFactory());
    try {
    await bridge.start();
    const threads = await bridge.threadList();
    expect(Array.isArray(threads)).toBe(true);
    expect(threads.length).toBeGreaterThan(0); // 本机已有历史会话

    const turns = await bridge.threadTurns(process.env.AGENTLINK_IPC_TEST_CONV ?? threads[0]!.id);
    expect(turns).toBeDefined();

    } finally { bridge.stop(); }
  }, 60000);
});
