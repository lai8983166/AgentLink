import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page, request }) => {
  await request.post("/__test__/control", { data: { type: "reset" } });
  await request.post("/__test__/control", { data: { type: "longHistory" } });
  await page.addInitScript(() => localStorage.setItem("agentlink-token", "isolated-e2e-token"));
});
test("1600 条会话首屏只取一页，刷新只补变化，翻页保持原阅读位置和草稿", async ({ page, request }) => {
  const responses: any[] = [];
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/v1/sessions/old1" && response.request().method() === "GET") void response.json().then(body => responses.push(body));
  });
  await page.goto("/"); await page.locator("a.card").first().click();
  await expect(page.getByText(/历史记录 1599/)).toBeVisible();
  await expect(page.locator('[data-message-type="agent"]')).toHaveCount(60);
  await expect.poll(() => responses.length).toBeGreaterThan(0);
  expect(responses[0].session.history).toHaveLength(60);
  await page.getByRole("button", { name: "刷新输出" }).click();
  await expect.poll(() => responses.at(-1)?.historySync.mode).toBe("patch");
  expect(responses.at(-1).session.history).toHaveLength(0);
  await page.getByRole("button", { name: "接管此会话" }).click();
  await page.getByRole("textbox").fill("未发送草稿");
  const history = page.getByTestId("conversation-history");
  await history.evaluate(el => { el.scrollTop = 0; });
  await page.getByRole("button", { name: "加载更早记录" }).click();
  await expect(page.locator('[data-message-type="agent"]')).toHaveCount(120);
  await expect(page.getByRole("textbox")).toHaveValue("未发送草稿");
  expect(await history.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await request.post("/__test__/control", { data: { type: "output", text: "增量恢复的新回复" } });
  await page.getByRole("button", { name: "刷新输出" }).click();
  await expect(page.getByText("增量恢复的新回复", { exact: true })).toHaveCount(1);
  const metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.sends).toHaveLength(0); expect(metrics.forkCalls).toBe(0);
});
test("重开使用 IndexedDB 历史版本，离线可查看但不能控制；重启后台安全回退最近一页", async ({ page, request }) => {
  await page.goto("/"); await page.locator("a.card").first().click();
  await expect(page.getByText(/历史记录 1599/)).toBeVisible();
  // 确认真实 IndexedDB 已提交，随后阻断详情请求验证冷启动缓存。
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("agentlink-history-v1", 1);
    open.onsuccess = () => { const db = open.result; const read = db.transaction("sessions").objectStore("sessions").count(); read.onsuccess = () => { resolve(read.result); db.close(); }; };
    open.onerror = () => reject(open.error);
  }))).toBeGreaterThan(0);
  const queries: URLSearchParams[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/sessions/old1?**", async route => { queries.push(new URL(route.request().url()).searchParams); await gate; await route.continue(); });
  await page.reload();
  await expect(page.getByText(/本地缓存，正在核对最新内容/)).toBeVisible();
  await expect(page.getByText(/历史记录 1599/)).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  await expect(page.getByRole("button", { name: "接管此会话" })).toHaveCount(0);
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  expect(queries[0]!.get("revision")).toBeTruthy();
  release();
  await expect(page.getByText(/本地缓存，正在核对最新内容/)).toHaveCount(0);
  await page.unroute("**/api/v1/sessions/old1?**");
  await request.post("/__test__/control", { data: { type: "restart" } });
  await expect(page.getByText(/历史记录 1599/)).toBeVisible();
  await expect(page.locator('[data-message-type="agent"]')).toHaveCount(60);
  const metrics = await (await request.post("/__test__/metrics")).json();
  expect(metrics.sends).toHaveLength(0); expect(metrics.resumeCalls).toBe(0); expect(metrics.forkCalls).toBe(0);
});
