import { test, expect } from "@playwright/test";

const raw = "12345678-1234-4234-8234-123456789abc", id = "claude:" + raw;
const headers = { Authorization: "Bearer isolated-e2e-token" };
test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await request.post("/__test__/control", { data: { type: "claudeConnect" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});
test("Claude 原终端列表、排队和输出；无 Codex 恢复调用且草稿不丢", async ({ page, request }) => {
  await page.goto("/");
  await page.locator("a.card").filter({ hasText: "CLAUDE" }).click();
  await expect(page.getByText("电脑终端已有输出", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "接管此会话" })).toHaveCount(0);
  const input = page.getByRole("textbox");
  await input.fill("手机继续原终端"); await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("已排队 · 等待终端开始执行", { exact: true })).toBeVisible();
  await input.fill("保留下一条草稿");
  await request.post("/__test__/control", { data: { type: "claudeComplete" } });
  await expect(page.getByText("Claude 手机控制成功", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("保留下一条草稿");
  await expect(page.locator('[data-message-type="user"]').filter({ hasText: "手机继续原终端" })).toHaveCount(1);
  const metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.claudeSends).toHaveLength(1); expect(metrics.resumeCalls).toBe(0); expect(metrics.forkCalls).toBe(0);
  await page.reload(); await expect(input).toHaveValue("保留下一条草稿");
  await expect(page.getByText("Claude 手机控制成功", { exact: true })).toBeVisible();
});
for (const nativeFirst of [false, true]) test(`Claude 审批${nativeFirst ? "电脑先处理" : "手机批准"}，不增加持久权限`, async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "claudeApproval" } });
  await page.goto("/" + id);
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准（本会话不再询问）" })).toHaveCount(0);
  if (nativeFirst) {
    await request.post("/__test__/control", { data: { type: "claudeLocalApproval" } });
    await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
    const response = await request.post(`/api/v1/sessions/${id}/approvals/claude-approval`, { headers, data: { decision: "accept" } });
    expect(response.status()).toBe(409);
  } else {
    await page.getByRole("button", { name: "批准", exact: true }).click();
    await expect(page.getByText(/✓ 已批准/)).toBeVisible();
    expect((await (await request.post("/__test__/metrics")).json()).claudeDecisions).toEqual(["allow"]);
  }
});
test("Claude Esc 限制、原终端恢复和失联，实时阻止不可执行的操作", async ({ page, request }) => {
  await page.goto("/" + id); const input = page.getByRole("textbox"); await expect(input).toBeEnabled();
  await request.post("/__test__/control", { data: { type: "claudeBlocked" } });
  await expect(input).toBeDisabled(); await expect(page.getByText(/终端按 Esc 停止后/)).toBeVisible();
  await request.post("/__test__/control", { data: { type: "claudeUnblock" } }); await expect(input).toBeEnabled();
  await request.post("/__test__/control", { data: { type: "claudeDisconnect" } });
  await expect(input).toBeDisabled({ timeout: 12000 });
  await expect(page.getByText(/^Claude 终端未连接，请保持电脑终端运行/).first()).toBeVisible();
});
test("关闭页面后，电脑端完成任务仍进入原生通知收件箱并链接原 Claude 会话", async ({ page, request }) => {
  const device = crypto.randomUUID();
  expect((await request.post("/api/v1/native-push/devices", { headers, data: { id: device } })).ok()).toBe(true);
  await page.goto("/" + id); await page.close();
  await request.post("/__test__/control", { data: { type: "claudeComplete" } });
  const response = await request.get(`/api/v1/native-push/devices/${device}/inbox?wait=0`, { headers });
  const { deliveries } = await response.json();
  expect(deliveries).toHaveLength(1); expect(deliveries[0].notification.url).toBe("/" + encodeURIComponent(id));
});
