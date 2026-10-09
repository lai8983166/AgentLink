import { test, expect, type Page } from "@playwright/test";

// Unlike the ordinary UI suite, this exercises actual registration, precaching and replacement.
test.use({ serviceWorkers: "allow" });
test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await request.post("/__test__/control", { data: { type: "pwaVersion", version: "old" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});

async function controlled(page: Page) {
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test("旧版只有注册脚本、没有更新界面时，关闭重开入口也能迁移到新版缓存", async ({ page, context, request }) => {
  await request.post("/__test__/control", { data: { type: "pwaVersion", version: "legacy" } });
  await page.goto("/"); await controlled(page);
  await expect(page.getByText("旧桌面入口", { exact: true })).toBeVisible();
  await request.post("/__test__/control", { data: { type: "pwaVersion", version: "new" } });
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect.poll(() => page.evaluate(async () => {
    // The current page can remain old; the new precache must be ready for the next launch.
    const html = await (await fetch("/index.html")).text();
    return !html.includes("旧桌面入口");
  })).toBe(true);
  await expect(page.getByText("旧桌面入口", { exact: true })).toBeVisible();
  await page.close();
  const reopened = await context.newPage(); await reopened.goto("/settings");
  const latest = (await (await request.get("/version.json")).json()).build;
  await expect(reopened.getByTestId("app-build")).toHaveText(latest);
  expect(await reopened.evaluate(() => localStorage.getItem("agentlink-token"))).toBe("isolated-e2e-token");
});

test("真实旧缓存升级：提示新版、显式重载后版本一致，保留配对和草稿、不重复发送", async ({ page, context, request }) => {
  await page.goto("/old1");
  await page.getByRole("button", { name: "接管此会话" }).click();
  await page.getByRole("textbox", { name: "消息指令" }).fill("升级前的草稿");
  await controlled(page);
  await page.goto("/settings");
  await expect(page.getByTestId("app-build")).toHaveText("pwa-old");
  // A second window remains open while the service worker changes; it must not silently reload.
  const other = await context.newPage(); await other.goto("/old1");
  await other.getByRole("textbox", { name: "消息指令" }).fill("另一窗口草稿");
  let reloads = 0;
  other.on("framenavigated", (frame) => { if (frame === other.mainFrame()) reloads++; });

  await request.post("/__test__/control", { data: { type: "pwaVersion", version: "new" } });
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByRole("button", { name: "更新页面" })).toBeEnabled();
  await expect(page.getByTestId("app-build")).toHaveText("pwa-old");
  await expect(other.getByText("有新版本可用 · 前往设置更新页面 ›")).toBeVisible();
  await expect(other.getByRole("textbox", { name: "消息指令" })).toHaveValue("另一窗口草稿");
  expect(reloads).toBe(0);

  await page.getByRole("button", { name: "更新页面" }).click();
  const latest = (await (await request.get("/version.json")).json()).build;
  await expect(page.getByTestId("app-build")).toHaveText(latest);
  await expect(page.getByText("当前已是最新版本", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("agentlink-token"))).toBe("isolated-e2e-token");
  await page.goto("/old1");
  await expect(page.getByRole("textbox", { name: "消息指令" })).toHaveValue("另一窗口草稿");
  expect((await (await request.post("/__test__/metrics")).json()).sends).toHaveLength(0);
  // Reopening a standalone entry loads the current precache, even if another window remains open.
  await other.close();
  const reopened = await context.newPage(); await reopened.goto("/settings");
  await expect(reopened.getByTestId("app-build")).toHaveText(latest);
  await controlled(reopened);
});

test("安装版离线检查不会假报最新版，恢复联网后可以更新", async ({ page, context, request }) => {
  await page.goto("/settings"); await controlled(page);
  await expect(page.getByTestId("app-build")).toHaveText("pwa-old");
  await expect(page.getByRole("button", { name: "检查更新" })).toBeEnabled();
  await context.setOffline(true);
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText("无法检查或下载更新，请检查网络后重试", { exact: true })).toBeVisible();
  await expect(page.getByText("当前已是最新版本", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("app-build")).toHaveText("pwa-old");
  await request.post("/__test__/control", { data: { type: "pwaVersion", version: "new" } });
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "更新页面" })).toBeEnabled();
  await page.getByRole("button", { name: "更新页面" }).click();
  const latest = (await (await request.get("/version.json")).json()).build;
  await expect(page.getByTestId("app-build")).toHaveText(latest);
});
