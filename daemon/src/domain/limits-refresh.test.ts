import { describe, expect, test } from "bun:test";
import { LimitsMonitor } from "./limits";
import { LimitsRefresh } from "./limits-refresh";
import { mapNotification, parseCodexRateLimits } from "../codex/mapper";

const primary = (usedPercent = 27) => ({ usedPercent, windowDurationMins: 300, resetsAt: 2000000000 });
const secondary = (usedPercent = 68) => ({ usedPercent, windowDurationMins: 10080, resetsAt: 2000500000 });
const response = (used = 27, accountId = "a") => ({ accountId, rateLimits: { primary: primary(used), secondary: secondary(), limitId: "codex" } });
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>((r) => { resolve = r; }); return { promise, resolve }; };

describe("官方账户额度读取", () => {
  test("并发刷新合并，同一账户 15 秒内复用，手动刷新绕过缓存", async () => {
    const monitor = new LimitsMonitor(); const wait = deferred(); let calls = 0, now = 100;
    const bridge = { ready: true, accountRateLimitsRead: () => { calls++; return calls === 1 ? wait.promise : Promise.resolve(response()); } };
    const refresh = new LimitsRefresh(monitor, bridge, () => now);
    const a = refresh.refresh(), b = refresh.refresh(true);
    expect(a).toBe(b); await Promise.resolve(); expect(calls).toBe(1);
    wait.resolve(response()); await a;
    expect(monitor.snapshot()).toMatchObject({ source: "official", primary: primary(), secondary: secondary(), measuredAt: 100 });
    await refresh.refresh(); expect(calls).toBe(1);
    await refresh.refresh(true); expect(calls).toBe(2);
    now += 15001; await refresh.refresh(); expect(calls).toBe(3);
  });

  test("超时或离线保留原值并标记失败，恢复后清除失败标记", async () => {
    const monitor = new LimitsMonitor(); let fail = false, now = 100;
    const bridge = { ready: true, accountRateLimitsRead: async () => { if (fail) throw new Error("offline"); return response(); } };
    const refresh = new LimitsRefresh(monitor, bridge, () => now++);
    await refresh.refresh(); fail = true; await refresh.refresh(true);
    expect(monitor.snapshot()).toMatchObject({ refreshFailed: true, measuredAt: 100, secondary: secondary() });
    fail = false; await refresh.refresh(true); expect(monitor.snapshot()?.refreshFailed).toBe(false);
    bridge.ready = false; await refresh.refresh(true); expect(monitor.snapshot()?.refreshFailed).toBe(true);
  });

  test("官方读取与历史隔离；时间更晚的历史也不能覆盖官方", async () => {
    const monitor = new LimitsMonitor();
    monitor.ingest(primary(90), secondary(42), 1000, { source: "history" });
    const refresh = new LimitsRefresh(monitor, { ready: true, accountRateLimitsRead: async () => response() }, () => 100);
    await refresh.refresh();
    monitor.ingest(primary(99), secondary(42), 2000, { source: "history" });
    expect(monitor.snapshot()).toMatchObject({ source: "official", secondary: secondary(68), measuredAt: 100 });
  });

  test("读取期间的新推送优先，不能被较早开始的读取回退", async () => {
    const monitor = new LimitsMonitor(); const wait = deferred();
    const refresh = new LimitsRefresh(monitor, { ready: true, accountRateLimitsRead: () => wait.promise }, () => 100);
    const pending = refresh.refresh();
    monitor.ingest(primary(30), secondary(69), 101);
    wait.resolve(response()); await pending;
    expect(monitor.snapshot()?.primary?.usedPercent).toBe(30);
  });

  test("账户切换立即清空，忽略旧请求并重新读取新账户", async () => {
    const monitor = new LimitsMonitor(); const wait = deferred(); let calls = 0;
    const refresh = new LimitsRefresh(monitor, { ready: true, accountRateLimitsRead: () => ++calls === 1 ? wait.promise : Promise.resolve(response(3, "b")) }, () => 100);
    monitor.ingest(primary(90), secondary(90), 99, { accountId: "a", source: "official" });
    const pending = refresh.refresh(); await Promise.resolve();
    monitor.reset(); refresh.invalidate();
    monitor.ingest(primary(90), secondary(90), 1000, { source: "history" });
    expect(monitor.snapshot()?.primary).toBeNull();
    wait.resolve(response(90, "a")); await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2); expect(monitor.snapshot()?.primary?.usedPercent).toBe(3);
    refresh.stop();
  });

  test("直接发现账户身份变化时接受新账户较低额度，不暴露身份", () => {
    const monitor = new LimitsMonitor();
    monitor.ingest(primary(90), secondary(90), 100, { accountId: "a" });
    monitor.ingest(primary(2), secondary(3), 99, { accountId: "b" });
    expect(monitor.snapshot()?.primary?.usedPercent).toBe(2);
    expect(JSON.stringify(monitor.snapshot())).not.toContain("accountId");
  });

  test("额度组按 codex 选择，缺失主窗口时保留周窗口，拒绝非法数字", () => {
    const other = { ...response().rateLimits, limitId: "other", primary: primary(99) };
    expect(parseCodexRateLimits({ rateLimits: other, rateLimitsByLimitId: { codex: response().rateLimits } })?.primary?.usedPercent).toBe(27);
    expect(parseCodexRateLimits({ rateLimits: other })).toBeNull();
    expect(parseCodexRateLimits({ rateLimits: { secondary: secondary() } })?.secondary).toEqual(secondary());
    expect(parseCodexRateLimits({ rateLimits: { primary: primary(101) } })).toBeNull();
    expect(mapNotification({ method: "account/rateLimits/updated", params: { rateLimits: other } })).toBeNull();
    expect(mapNotification({ method: "account/updated", params: {} })?.kind).toBe("accountChanged");
  });

  test("短窗口与周窗口同一重置时间也分别告警，99.9% 和历史记录不告警", () => {
    const monitor = new LimitsMonitor(); const alerts: string[] = [];
    monitor.onExhausted = (w) => { alerts.push(w); };
    monitor.ingest(primary(100), { ...secondary(100), resetsAt: 2000000000 }, 1, { source: "history" });
    expect(alerts).toEqual([]);
    monitor.ingest(primary(99.9), secondary(99.9), 2);
    expect(alerts).toEqual([]);
    monitor.ingest(primary(100), { ...secondary(100), resetsAt: 2000000000 }, 3);
    expect(alerts).toEqual(["5h", "week"]);
  });
});
