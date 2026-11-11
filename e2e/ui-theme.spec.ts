import { test, expect } from "@playwright/test";

test("default collage theme has no user switch and keeps mobile controls reachable", async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "punk-collage");
  await expect(page.locator(".fab")).toHaveCSS("background-color", "rgb(232, 21, 28)");
  await expect(page.locator(".fab")).toHaveCSS("border-radius", "0px");
  await page.locator(".fab").click();
  await page.getByRole("textbox", { name: "任务描述" }).fill("人工主题回归任务");
  await expect(page.getByRole("textbox", { name: "任务描述" })).toHaveValue("人工主题回归任务");
  await expect(page.getByRole("button", { name: "开始任务" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByText("解除配对", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /主题|换肤|风格切换/ })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
