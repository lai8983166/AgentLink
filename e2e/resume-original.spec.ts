import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

test("无人持有时主动继续原会话：同 ID、历史和权限保留，发指令后刷新仍运行", async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "ownership", available: false } });
  await page.goto("/old1");
  const input = page.getByRole("textbox");
  await expect(page.getByTestId("conversation-history")).toContainText("旧会话第一条");
  await expect(input).toBeDisabled();
  if (test.info().project.name === "mobile") await page.screenshot({ path: test.info().outputPath("resume-original-before.png") });
  expect((await (await request.post("/__test__/metrics")).json()).resumeCalls).toBe(0);
  await page.getByRole("button", { name: "继续原会话", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(page).toHaveURL(/\/old1$/);
  await expect(page.getByTestId("conversation-history")).toContainText("旧会话第一条");
  if (test.info().project.name === "mobile") await page.screenshot({ path: test.info().outputPath("resume-original-after.png") });
  await input.fill("在原会话继续的指令");
  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();
  await page.reload();
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("conversation-history")).toContainText("在原会话继续的指令");
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();
  const metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.resumes).toEqual([{ threadId: "old1", approvalPolicy: "never", sandbox: "danger-full-access" }]);
  expect(metrics.localSends).toEqual([{ threadId: "old1", approvalPolicy: "never", input: [{ type: "text", text: "在原会话继续的指令" }] }]);
  expect(metrics.forkCalls).toBe(0); expect(metrics.sends).toEqual([]);
});

test("owner 或写锁仍在、探测异常、恢复竞争：始终禁用输入，不自动 fork", async ({ page, request }) => {
  await page.goto("/old1");
  const resume = page.getByRole("button", { name: "继续原会话", exact: true });
  await resume.click();
  await expect(page.getByText(/原会话正在电脑端打开中/)).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  await request.post("/__test__/control", { data: { type: "ownership", available: false, writerHeld: true } });
  await resume.click();
  await expect(page.getByText(/原会话仍被其他入口持有/)).toBeVisible();
  await request.post("/__test__/control", { data: { type: "ownership", available: false, error: "unexpected-owner-error" } });
  await resume.click();
  await expect(page.getByText(/无法确认|无法探测|占用状态/)).toBeVisible();
  let metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.resumeCalls).toBe(0); expect(metrics.forkCalls).toBe(0);
  await request.post("/__test__/control", { data: { type: "ownership", available: false } });
  await request.post("/__test__/control", { data: { type: "resumeConflict" } });
  await resume.click();
  await expect(page.getByText(/会话正在电脑上使用中/)).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.resumeCalls).toBe(1); expect(metrics.forkCalls).toBe(0); expect(metrics.localSends).toEqual([]);
});
