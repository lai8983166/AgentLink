import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.use({ serviceWorkers: "allow" });
const apk = Buffer.from([80, 75, 3, 4, 1, 2, 3, 4]);
test.beforeEach(async ({ page, context, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
  // 仅替换网络层的文件内容，真实 Service Worker 必须主动放行下载导航。
  await context.route("**/downloads/agentlink.apk", (route) => route.fulfill({ status: 200,
    headers: { "Content-Type": "application/vnd.android.package-archive", "Content-Disposition": "attachment; filename=AgentLink.apk" }, body: apk }));
});
async function downloadApk(page: Page) {
  const pending = page.waitForEvent("download", { timeout: 5000 });
  await page.goto("/downloads/agentlink.apk").catch((error) => { if (!String(error).includes("ERR_ABORTED") && !String(error).includes("Download is starting")) throw error; });
  const download = await pending;
  expect(download.suggestedFilename()).toBe("AgentLink.apk");
  expect(readFileSync((await download.path())!)).toEqual(apk);
}
test("已安装网页缓存时 APK 仍下载文件，API 地址也不回落到聊天页面", async ({ page }) => {
  await page.goto("/settings");
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await downloadApk(page);
  const response = await page.goto("/api/v1/health");
  expect(response?.fromServiceWorker()).toBe(false);
  expect(await response?.json()).toMatchObject({ ok: true, daemon: "agentlink" });
});

test("旧缓存造成下载空白后，更新 Service Worker 即恢复下载且保留配对", async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "pwaVersion", version: "old" } });
  await page.goto("/settings");
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const response = await page.goto("/downloads/agentlink.apk");
  expect(response?.fromServiceWorker()).toBe(true);
  expect(response?.headers()["content-type"]).toContain("text/html");
  await expect(page.locator("#root")).toBeEmpty();
  const previous = await page.evaluateHandle(() => navigator.serviceWorker.controller);
  await request.post("/__test__/control", { data: { type: "pwaVersion", version: "new" } });
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect.poll(() => page.evaluate((old) => navigator.serviceWorker.controller !== old, previous)).toBe(true);
  await previous.dispose();
  await downloadApk(page);
  expect(await page.evaluate(() => localStorage.getItem("agentlink-token"))).toBe("isolated-e2e-token");
});
