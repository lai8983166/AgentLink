import { describe, expect, test } from "bun:test";
import { IpcClient } from "./client";
import { IpcMethod } from "./protocol";

/**
 * 真实桌面 IPC 兼容性回归（任务 6.1/6.2/6.3，slow）：
 * AGENTLINK_SLOW_TESTS=1 且桌面端运行时执行。
 * AGENTLINK_IPC_TEST_CONV 可指定被测会话 id（默认用验证文档的 READY 会话）。
 * 6.3（VS Code 同管道）：把 AGENTLINK_IPC_TEST_CONV 换成 VS Code 持有的活跃会话 id 再跑一次即可。
 */
const SLOW = !!process.env.AGENTLINK_SLOW_TESTS;
const CONV = process.env.AGENTLINK_IPC_TEST_CONV ?? "01a10ef1-c3d4-7d10-8577-f9989d558ab8";

describe.skipIf(!SLOW)("桌面 IPC 兼容性回归（slow）", () => {
  test("握手 + owner 发现 + 快照字段存在性 + steer 探测", async () => {
    const client = new IpcClient(undefined, { callTimeoutMs: 6000, log: (...a) => console.log("[slow]", ...a) });
    client.connect();
    await new Promise<void>((r) => {
      client.onConnected = () => r();
      setTimeout(() => r(), 8000);
    });
    // 6.1 握手：clientId 与对端信息
    expect(client.clientId).not.toBe("initializing-client");
    console.log("[slow] peer:", JSON.stringify(client.peerInfo).slice(0, 160));

    // 6.1 owner 发现（协议形状断言：resultType 字段必须存在）
    const owner = (await client.callFull(IpcMethod.threadOwnerDiscovery, {
      hostId: "local",
      conversationId: CONV,
    })) as { resultType?: string; handledByClientId?: string };
    expect(typeof owner.resultType).toBe("string");
    console.log("[slow] discovery:", JSON.stringify(owner).slice(0, 120));

    if (owner.resultType === "success" && owner.handledByClientId) {
      // 6.1 快照字段存在性（title/turnHistory/requests/latestThreadSettings）
      const snapshot = await new Promise<Record<string, unknown>>((resolve) => {
        const t = setTimeout(() => resolve({}), 10000);
        client.broadcastHandler = (b) => {
          const cs = (b.params as { conversationId?: string; change?: { type?: string; conversationState?: unknown } })
            ?.conversationId === CONV
            ? (b.params?.change as { conversationState?: unknown })?.conversationState
            : undefined;
          if (cs) {
            clearTimeout(t);
            resolve(cs as Record<string, unknown>);
          }
        };
        client.sendBroadcast(
          "thread-stream-following-changed",
          { hostId: "local", conversationId: CONV, following: true },
          [owner.handledByClientId!],
        );
      });
      expect(typeof (snapshot.title as unknown)).toBe("string");
      expect(snapshot.turnHistory).toBeDefined();
      expect(Array.isArray(snapshot.requests)).toBe(true);
      expect(snapshot.latestThreadSettings).toBeDefined();
      console.log("[slow] 快照字段齐全 ✓ title=", String(snapshot.title).slice(0, 40));
      // 退订
      client.sendBroadcast(
        "thread-stream-following-changed",
        { hostId: "local", conversationId: CONV, following: false },
        [owner.handledByClientId!],
      );
    } else {
      console.log("[slow] 会话未被持有（桌面端未开该对话），跳过快照断言");
    }

    // 6.2 steer 方法探测：存在则记录，不存在记录跳过（不影响通过）
    try {
      const steer = (await client.callFull("thread-follower-steer-turn", {
        conversationId: CONV,
        __probe: true,
      })) as { error?: { message?: string } };
      console.log("[slow] steer 探测响应:", JSON.stringify(steer).slice(0, 120));
    } catch (e) {
      console.log("[slow] steer 不可用:", (e as Error).message.slice(0, 80));
    }

    client.disconnect();
  }, 60000);
});
