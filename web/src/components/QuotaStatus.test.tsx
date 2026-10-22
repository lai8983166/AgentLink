import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RateLimit } from "@agentlink/shared";
import { QuotaStatus } from "./QuotaStatus";
import { mergeQuota } from "../quota";

const now = Date.parse("2026-10-22T03:00:00Z");
const rate = (used = 27): RateLimit => ({ primary: { usedPercent: used, windowDurationMins: 300, resetsAt: now / 1000 + 3600 }, secondary: { usedPercent: 68, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 * 3 }, measuredAt: now, source: "official", updatedAt: now });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mount = (value: RateLimit | null, error = false) => { vi.spyOn(Date, "now").mockReturnValue(now); render(<QuotaStatus rate={value} error={error} />); return screen.getByTestId("quota-status"); };

describe("额度清楚显示剩余与数据来源", () => {
  test("官方已用 27/68 显示剩余 73/32，周重置日期可见", () => {
    const text = mount(rate()).textContent;
    expect(text).toContain("5 小时剩余 73%"); expect(text).toContain("每周剩余 32%");
    expect(text).toContain("10月25日"); expect(text).toContain("官方额度");
  });
  test.each([98.5, 99, 99.9])("已用 %s%% 不误报用尽，小于 1%% 的剩余不显示为零", (used) => {
    const text = mount(rate(used)).textContent;
    expect(text).not.toContain("已用尽");
    if (used > 99) expect(text).toContain("剩余 <1%");
  });
  test("精确用尽显示零，短窗口过期后显示等待更新，周窗口保持原位", () => {
    expect(mount(rate(100)).textContent).toContain("剩余 0%（已用尽）"); cleanup();
    const value = rate(100); value.primary!.resetsAt = now / 1000 - 1;
    const text = mount(value).textContent;
    expect(text).toContain("5 小时：等待更新"); expect(text).toContain("每周剩余 32%"); expect(text).not.toContain("已用尽");
  });
  test("仅有周窗口不能显示成短窗口，其他时长按数据标注", () => {
    const value = rate(); value.primary = null;
    expect(mount(value).textContent).not.toContain("5 小时"); cleanup();
    value.primary = { ...rate().primary!, windowDurationMins: 15 };
    expect(mount(value).textContent).toContain("15 分钟剩余");
  });
  test("历史、过期、刷新失败均明确标注为上次值，缺失不推测", () => {
    expect(mount({ ...rate(), source: "history" }).textContent).toContain("历史记录");
    expect(screen.getByTestId("quota-status").textContent).toContain("上次剩余"); cleanup();
    expect(mount({ ...rate(), measuredAt: now - 121000 }).textContent).toContain("数据已过期"); cleanup();
    expect(mount(rate(), true).textContent).toContain("刷新失败"); cleanup();
    expect(mount(null).textContent).toBe("额度暂不可用");
  });
  test("HTTP 旧响应不覆盖新推送，账户清空按后台修订时间生效", () => {
    const newer = { ...rate(30), updatedAt: now + 1 };
    expect(mergeQuota(newer, rate(27))).toBe(newer);
    const cleared = { ...rate(), primary: null, secondary: null, measuredAt: null, updatedAt: now + 2 };
    expect(mergeQuota(newer, cleared)).toBe(cleared);
    expect(mergeQuota(cleared, newer)).toBe(cleared);
  });
});
