import { describe, expect, test } from "bun:test";
import { IpcClient } from "./client";
import { IpcMethod } from "./protocol";

/**
 * 真实桌面 IPC 兼容性回归（任务 6.1/6.2/6.3，slow）：
 * AGENTLINK_SLOW_TESTS=1 且桌面端运行时执行。
 * 必须用 AGENTLINK_IPC_TEST_CONV 指定电脑端实际打开的会话 id。
 * 6.3（VS Code 同管道）：把 AGENTLINK_IPC_TEST_CONV 换成 VS Code 持有的活跃会话 id 再跑一次即可。
 */
const SLOW = !!process.env.AGENTLINK_SLOW_TESTS;
const CONV = process.env.AGENTLINK_IPC_TEST_CONV;

describe.skipIf(!SLOW)("桌面 IPC 兼容性回归（slow）", () => {
  test("只读握手 + 实际 owner + 快照字段存在性，不以未打开会话冒充通过", async () => {
    if (!CONV) throw new Error("请设置 AGENTLINK_IPC_TEST_CONV 为电脑端实际打开的会话 ID");
    const client = new IpcClient(undefined, { callTimeoutMs: 6000, log: (...a) => console.log("[slow]", ...a) });
    try {
    client.connect();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("桌面握手超时")), 8000);
      client.onConnected = () => { clearTimeout(timer); resolve(); };
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
    expect(owner.resultType).toBe("success");
    expect(owner.handledByClientId).toBeTruthy();

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
    }

    } finally { client.disconnect(); }
  }, 60000);
});
