import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

test("首次状态、审批恢复、桌面拒绝可重试，文件审批使用正确通道", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText("等待审批", { exact: true })).toBeVisible();
  await page.getByText("查看此项目的进展", { exact: true }).click();
  await expect(page.getByText("echo E2E", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "接管此会话" }).click();
  await expect(page.getByRole("button", { name: "接管此会话" })).toHaveCount(0);
  await request.post("/__test__/control", { data: { type: "rejectApproval", enabled: true } });
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByText(/desktop rejected/)).toBeVisible();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await request.post("/__test__/control", { data: { type: "rejectApproval", enabled: false } });
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByText(/已批准/)).toBeVisible();
  await request.post("/__test__/control", { data: { type: "fileApproval" } });
  await expect(page.getByText("请求修改文件", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByText(/文件改动 — ✓ 已批准/)).toBeVisible();
  const metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.approvalMethods).toContain("thread-follower-file-approval-decision"); expect(metrics.resumeCalls).toBe(0);
});

test("发送回执丢失后核对成功，重开页面保留接管，同文本新指令不被误吞", async ({ page, request }) => {
  await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox");
  await expect(input).toBeEnabled();
  await page.route("**/api/v1/sessions/old1/message", async (route) => { await route.fetch(); await route.abort("failed"); });
  await input.fill("继续 E2E"); await page.getByRole("button", { name: "↑" }).click();
  await expect(page.getByText("电脑端已接收", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  await page.unroute("**/api/v1/sessions/old1/message");
  expect((await (await request.post("/__test__/metrics")).json()).sends).toHaveLength(1);
  await page.reload(); await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "接管此会话" })).toHaveCount(0);
  await input.fill("继续 E2E"); await page.getByRole("button", { name: "↑" }).click();
  await expect(input).toHaveValue("");
  const metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.sends).toHaveLength(2); expect(new Set(metrics.sends).size).toBe(2); expect(metrics.resumeCalls).toBe(0);
});

test("离线重连及后台重启后恢复接管、草稿和后续实时状态", async ({ page, context, request }) => {
  await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  const input = page.getByRole("textbox"); await expect(input).toBeEnabled(); await input.fill("保存的草稿");
  await context.setOffline(true);
  await request.post("/__test__/control", { data: { type: "restart" } });
  await context.setOffline(false);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("手机与后台已连接", { exact: false })).toBeVisible();
  await expect(input).toBeEnabled(); await expect(input).toHaveValue("保存的草稿");
  await expect(page.getByRole("button", { name: "接管此会话" })).toHaveCount(0);
  await request.post("/__test__/control", { data: { type: "done" } });
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await page.reload(); await expect(input).toHaveValue("保存的草稿");
});
