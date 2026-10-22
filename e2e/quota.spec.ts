import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

test("额度显示剩余与完整重置日期，手动刷新请求官方最新额度且手机不横向溢出", async ({ page }, testInfo) => {
  let forced = 0;
  await page.route("**/api/v1/status**", async (route) => {
    const force = new URL(route.request().url()).searchParams.get("refreshLimits") === "1";
    if (force) forced++;
    const now = Date.now();
    await route.fulfill({ json: { rateLimits: {
      primary: { usedPercent: force ? 28 : 27, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: force ? 69 : 68, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 * 3 },
      measuredAt: now, updatedAt: now, source: "official",
    }, connections: { desktop: "ready" } } });
  });
  await page.goto("/");
  const quota = page.getByTestId("quota-status");
  await expect(quota).toContainText("5 小时剩余 73%");
  await expect(quota).toContainText("每周剩余 32%");
  await expect(quota).toContainText(/\d+月\d+日 \d{2}:\d{2} 重置/);
  await page.getByRole("button", { name: "刷新会话" }).click();
  await expect(quota).toContainText("每周剩余 31%");
  expect(forced).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("quota.png") });
});

test("接近用尽、窗口已过期、历史数据和刷新失败不伪造当前额度", async ({ page }) => {
  let state = "near";
  await page.route("**/api/v1/status**", async (route) => {
    const now = Date.now();
    await route.fulfill({ json: { rateLimits: {
      primary: { usedPercent: 99.9, windowDurationMins: 300, resetsAt: now / 1000 + (state === "expired" ? -1 : 3600) },
      secondary: { usedPercent: 68, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 },
      measuredAt: now, updatedAt: now, source: state === "history" ? "history" : "official", refreshFailed: state === "history",
    } } });
  });
  await page.goto("/"); const quota = page.getByTestId("quota-status");
  await expect(quota).toContainText("剩余 <1%"); await expect(quota).not.toContainText("已用尽");
  state = "expired"; await page.getByRole("button", { name: "刷新会话" }).click();
  await expect(quota).toContainText("5 小时：等待更新"); await expect(quota).toContainText("每周剩余 32%");
  await expect(page.getByRole("button", { name: "刷新会话" })).toBeEnabled();
  state = "history"; await page.getByRole("button", { name: "刷新会话" }).click();
  await expect(quota).toContainText("历史记录"); await expect(quota).toContainText("上次剩余"); await expect(quota).toContainText("刷新失败");
});
