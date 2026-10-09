import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "./control-store";
import { SessionRegistry } from "./sessions";

describe("指令接收回执和重启恢复", () => {
  test("同意图并发及成功重试只发送一次；相同文本新意图正常发送", async () => {
    const store = new ControlStore();
    let calls = 0;
    const registry = new SessionRegistry({} as never, {} as never, {} as never, {} as never, store);
    registry.setDesktopManager({ isTakenOver: () => true, sendTurn: async () => { calls++; } } as never);
    const [a, b] = await Promise.all([registry.sendMessage("s1", "继续", "m1"), registry.sendMessage("s1", "继续", "m1")]);
    expect(a.state).toBe("accepted"); expect(b).toEqual(a); expect(calls).toBe(1);
    await registry.sendMessage("s1", "继续", "m1"); expect(calls).toBe(1);
    await registry.sendMessage("s1", "继续", "m2"); expect(calls).toBe(2);
    expect(() => registry.sendMessage("s1", "不同内容", "m1")).toThrow("不同内容");
    store.close();
  });

  test("明确拒绝可重试；超时结果待确认，不能盲目重复发送", async () => {
    const store = new ControlStore();
    const registry = new SessionRegistry({} as never, {} as never, {} as never, {} as never, store);
    let error = "no-client-found";
    let calls = 0;
    registry.setDesktopManager({ isTakenOver: () => true, sendTurn: async () => { calls++; if (error) throw new Error(error); } } as never);
    await expect(registry.sendMessage("s1", "继续", "m1")).rejects.toThrow(error);
    expect(registry.messageReceipt("s1", "m1")?.state).toBe("failed");
    error = ""; await registry.sendMessage("s1", "继续", "m1"); expect(calls).toBe(2);
    error = "ipc timeout";
    await expect(registry.sendMessage("s1", "继续", "m2")).rejects.toThrow(error);
    expect(registry.messageReceipt("s1", "m2")?.state).toBe("uncertain");
    expect(() => registry.sendMessage("s1", "继续", "m2")).toThrow("结果待确认"); expect(calls).toBe(3);
    store.close();
  });

  test("成功回执落盘；重启后未收回执的发送变成待确认，绝不自动执行", () => {
    const folder = mkdtempSync(join(tmpdir(), "agentlink-delivery-"));
    const path = join(folder, "control.db");
    let store = new ControlStore(path);
    store.saveDelivery("s1", "已收到", { clientMessageId: "m1", state: "accepted", updatedAt: 1, error: null });
    store.saveDelivery("s1", "进行中", { clientMessageId: "m2", state: "sending", updatedAt: 2, error: null });
    store.close(); store = new ControlStore(path);
    expect(store.delivery("s1", "m1")?.state).toBe("accepted");
    expect(store.delivery("s1", "m2")?.state).toBe("uncertain");
    store.close(); rmSync(folder, { recursive: true, force: true });
  });
});
