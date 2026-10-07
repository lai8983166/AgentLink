import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsMonitor } from "./limits";
import { findRollout, tailRateLimits } from "../ipc/rollout-limits";
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
    m.ingest(win(50), null);
    m.ingest(win(50), null); // 无变化
    expect(changes).toBe(1);
    m.ingest(win(99.9), null); // 用尽
    expect(exhausted).toEqual(["5h"]);
    m.ingest(win(100), null); // 仍然用尽、同窗口 → 不重复
    expect(exhausted).toEqual(["5h"]);
    m.ingest(win(100, 2000003600), null); // 新窗口（resetsAt 变化）→ 再通知
    expect(exhausted).toEqual(["5h", "5h"]);
    expect(changes).toBe(4); // 50 → 99.9 → 100 → 新窗口
  });

  test("周窗用尽也通知；旧数据不回退", () => {
    m.ingest(win(80), win(100));
    expect(exhausted).toEqual(["week"]);
    m.ingest(win(30), win(40)); // resetsAt 相同但 usedPercent 更小 → 视为旧数据丢弃
    expect(m.snapshot()?.primary.usedPercent).toBe(80);
  });

  test("snapshot：窗口过期后不再展示", () => {
    m.ingest(win(50, 1), null); // 早已过期
    expect(m.snapshot()).toBeNull();
  });
});

describe("rollout 限额尾读", () => {
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
    expect(parseRateLimits({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1 } })?.primary.usedPercent).toBe(10);
    expect(parseRateLimits({ primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 } })?.primary.usedPercent).toBe(10);
    expect(parseRateLimits({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1 }, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2 } })?.secondary?.usedPercent).toBe(20);
    expect(parseRateLimits({ secondary: { used_percent: 20, window_minutes: 1, resets_at: 2 } })).toBeNull(); // 无 primary
    expect(parseRateLimits(null)).toBeNull();
  });
});
