import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

test("回执和用户消息迟到、模型先到：发送立即显示、顺序稳定且桌面同步后不重复", async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "delayMessages" } });
  await page.goto("/old1"); await page.getByRole("button", { name: "接管此会话" }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/sessions/old1/message", async (route) => {
    const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  const history = page.getByTestId("conversation-history");
  const rows = history.locator("[data-message-type]");
  try {
    await page.getByRole("textbox").fill("这条指令应立即出现"); await page.getByRole("button", { name: "↑" }).click();
    await expect(history.locator('[data-message-type="user"]')).toContainText("这条指令应立即出现", { timeout: 1000 });
    await expect(history.getByText("模型先到的回复", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-message-type", "user");
    await expect(rows.first()).toContainText("发送中");
    release();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await expect(rows.first()).toContainText("等待同步");
    await request.post("/__test__/control", { data: { type: "flushMessages" } });
    await expect(history.locator('[data-message-type="user"]')).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-message-id", /^server-/);
    await expect(rows.first()).toHaveAttribute("data-message-type", "user");
    await page.reload(); await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-message-type", "user");
    expect((await (await request.post("/__test__/metrics")).json()).sends).toHaveLength(1);
  } finally { release(); }
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
