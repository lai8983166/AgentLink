import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsMonitor } from "./limits";
import { findRollout, tailRateLimits, mergeLimits } from "../ipc/rollout-limits";
import { parseRateLimits } from "../codex/mapper";
import type { RateLimitWindow } from "@agentlink/shared";

const win = (usedPercent: number, resetsAt = 2000000000): RateLimitWindow => ({
  usedPercent,
  windowDurationMins: 300,
  resetsAt,
});

describe("LimitsMonitor（额度可见/限额告警）", () => {
  let m: LimitsMonitor;
  let changes: number;
  let exhausted: Array<"5h" | "week">;
  beforeEach(() => {
    m = new LimitsMonitor();
    changes = 0;
    exhausted = [];
    m.onChange = () => changes++;
    m.onExhausted = (w) => exhausted.push(w);
  });

  test("变化才通知；用尽上升沿只按 resetsAt 通知一次；新窗口再通知", () => {
    m.ingest(win(50), null, 1);
    m.ingest(win(50), null, 1); // 无变化
    expect(changes).toBe(1);
    m.ingest(win(99.9), null); // 接近用尽仍不告警
    expect(exhausted).toEqual([]);
    m.ingest(win(100), null); // 仍然用尽、同窗口 → 不重复
    expect(exhausted).toEqual(["5h"]);
    m.ingest(win(100, 2000003600), null); // 新窗口（resetsAt 变化）→ 再通知
    expect(exhausted).toEqual(["5h", "5h"]);
    expect(changes).toBe(4); // 50 → 99.9 → 100 → 新窗口
  });

  test("周窗用尽也通知；旧数据不回退", () => {
    m.ingest(win(80), { ...win(100), windowDurationMins: 10080 }, 20);
    expect(exhausted).toEqual(["week"]);
    m.ingest(win(30), win(40), 10);
    expect(m.snapshot()?.primary?.usedPercent).toBe(80);
  });

  test("过期窗口保留原始重置时间供客户端显示等待更新，不推算恢复", () => {
    m.ingest(win(50, 1), null); // 早已过期
    expect(m.snapshot()?.primary?.resetsAt).toBe(1);
  });

  test("接受更新的官方下调，旧记录即使重置时间更晚也不能覆盖", () => {
    m.ingest(win(80), win(70), 20);
    m.ingest(win(30), win(40), 30);
    m.ingest(win(90, 2000000002), win(90), 10);
    expect(m.snapshot()?.primary?.usedPercent).toBe(30);
    expect(m.snapshot()?.secondary?.usedPercent).toBe(40);
  });

  test("短窗口过期但周窗口有效时保留窗口身份", () => {
    m.ingest(win(100, Date.now() / 1000 - 1), { ...win(68), windowDurationMins: 10080 });
    expect(m.snapshot()?.primary?.windowDurationMins).toBe(300);
    expect(m.snapshot()?.secondary?.usedPercent).toBe(68);
  });

  test("仅更新时间或周重置时间变化也推送", () => {
    m.ingest(win(20), win(40), 10);
    m.ingest(win(20), win(40), 20);
    m.ingest(win(20), win(40, 2000000002), 20);
    expect(changes).toBe(3);
  });
});

describe("历史额度选择", () => {
  test("昨天周重置晚 2 秒不能覆盖今天快照，也不能借用今天更新时间", () => {
    const latest = { primary: win(27), secondary: win(68), measuredAt: 200 };
    const older = { primary: win(90), secondary: win(42, 2000000002), measuredAt: 100 };
    expect(mergeLimits(latest, older)).toBe(latest);
    expect(mergeLimits(older, latest)).toBe(latest);
    expect(mergeLimits(latest, { ...older, measuredAt: null })).toBe(latest);
  });
});

describe("rollout 限额尾读", () => {
  test("未创建的 rollout 不永久缓存，并按 sessionsRoot 隔离", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlink-new-rl-"));
    expect(findRollout("new-id", root)).toBeNull();
    const path = join(root, "rollout-new-id.jsonl");
    writeFileSync(path, "");
    expect(findRollout("new-id", root)).toBe(path);
    const other = mkdtempSync(join(tmpdir(), "agentlink-other-rl-"));
    expect(findRollout("new-id", other)).toBeNull();
  });
  test("跳过末尾无效记录并识别 camelCase", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlink-camel-rl-"));
    const path = join(root, "x.jsonl");
    writeFileSync(path, [JSON.stringify({ timestamp: "2026-10-22T02:00:00Z", payload: { rateLimits: { primary: win(68) } } }), JSON.stringify({ payload: { rate_limits: { primary: {} } } })].join("\n"));
    expect(tailRateLimits(path)?.primary.usedPercent).toBe(68);
    expect(tailRateLimits(path)?.measuredAt).toBe(Date.parse("2026-10-22T02:00:00Z"));
  });
  test("找到 rollout 并提取最后一条 rate_limits（snake_case）", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlink-rl-"));
    mkdirSync(join(root, "2026/10/07"), { recursive: true });
    const id = "0aaa-bbbb";
    const path = join(root, "2026/10/07", `rollout-2026-10-07T10-00-00-1-${id}.jsonl`);
    const rec = (n: number) =>
      JSON.stringify({ type: "token_usage_record", payload: { rate_limits: { primary: { used_percent: n, window_minutes: 300, resets_at: 1791300000 }, secondary: { used_percent: n * 2, window_minutes: 10080, resets_at: 1791800000 } } } });
    writeFileSync(path, [rec(1), rec(2), rec(3), '{"type":"other"}'].join("\n"));
    expect(findRollout(id, root)).toBe(path);
    const rl = tailRateLimits(path);
    expect(rl?.primary.usedPercent).toBe(3);
    expect(rl?.secondary?.usedPercent).toBe(6);
    expect(rl?.primary.windowDurationMins).toBe(300);
    // 缓存命中（第二次直接返回）
    expect(findRollout(id, root)).toBe(path);
  });

  test("无 rate_limits 记录 → null", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlink-rl2-"));
    const path = join(root, "x.jsonl");
    writeFileSync(path, '{"type":"event"}\n'.repeat(100));
    expect(tailRateLimits(path)).toBeNull();
  });
});

describe("parseRateLimits（命名防御）", () => {
  test("snake_case / camelCase / 缺 secondary", () => {
    expect(parseRateLimits({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1 } })?.primary?.usedPercent).toBe(10);
    expect(parseRateLimits({ primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 } })?.primary?.usedPercent).toBe(10);
    expect(parseRateLimits({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1 }, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2 } })?.secondary?.usedPercent).toBe(20);
    expect(parseRateLimits({ secondary: { used_percent: 20, window_minutes: 1, resets_at: 2 } })?.primary).toBeNull();
    expect(parseRateLimits(null)).toBeNull();
  });
});
